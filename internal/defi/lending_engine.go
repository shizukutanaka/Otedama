package defi

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"go.uber.org/zap"
)

// LendingEngine manages decentralized lending operations
type LendingEngine struct {
	markets         map[string]*LendingMarket
	collateralMgr   *CollateralManager
	interestModel   *InterestRateModel
	liquidationEng  *LiquidationEngine
	crossChainMgr   *CrossChainManager
	revenueTracker  *RevenueTracker
	ctx             context.Context
	cancel          context.CancelFunc
	mutex           sync.RWMutex
}

// LendingMarket represents a lending market for a specific asset
type LendingMarket struct {
	Asset           string
	TotalSupply     float64
	TotalBorrows    float64
	UtilizationRate float64
	SupplyAPY       float64
	BorrowAPY       float64
	ReserveFactor   float64
	CollateralFactor float64
	LastUpdate      time.Time
	Reserves        float64
	Users           map[string]*UserPosition
}

// UserPosition represents a user's lending position
type UserPosition struct {
	UserAddress     string
	SuppliedAmount  float64
	BorrowedAmount  float64
	CollateralValue float64
	HealthFactor    float64
	LastUpdate      time.Time
	RewardsEarned   float64
}

// CollateralManager manages collateral assets
type CollateralManager struct {
	collateralAssets map[string]*CollateralAsset
	userCollateral   map[string]map[string]float64
	liquidationThreshold float64
	mutex            sync.RWMutex
}

// CollateralAsset represents a collateral asset
type CollateralAsset struct {
	Symbol           string
	Address          string
	Decimals         int
	CollateralFactor float64
	LiquidationFactor float64
	Price            float64
	LastUpdate       time.Time
}

// InterestRateModel calculates interest rates based on utilization
type InterestRateModel struct {
	baseRatePerYear      float64
	multiplierPerYear    float64
	jumpMultiplierPerYear float64
	kink                  float64
}

// LiquidationEngine handles liquidations
type LiquidationEngine struct {
	liquidationIncentives float64
	closeFactor           float64
	liquidationQueue      []*LiquidationRequest
	mutex                 sync.RWMutex
}

// LiquidationRequest represents a liquidation request
type LiquidationRequest struct {
	UserAddress    string
	Asset          string
	Amount         float64
	CollateralAsset string
	Timestamp      time.Time
	Status         string
}

// CrossChainManager handles cross-chain lending
type CrossChainManager struct {
	bridgeContracts map[string]string
	supportedChains map[string]*ChainConfig
	wrappedAssets   map[string]string
	lastSync        time.Time
}

// ChainConfig represents a supported blockchain
type ChainConfig struct {
	Name        string
	ChainID     int
	RPCURL      string
	BridgeAddr  string
	LastBlock   uint64
}

// NewLendingEngine creates a new lending engine
func NewLendingEngine() *LendingEngine {
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &LendingEngine{
		markets:        make(map[string]*LendingMarket),
		collateralMgr:  NewCollateralManager(),
		interestModel:  NewInterestRateModel(),
		liquidationEng: NewLiquidationEngine(),
		crossChainMgr:  NewCrossChainManager(),
		revenueTracker: NewRevenueTracker(),
		ctx:            ctx,
		cancel:         cancel,
	}

	// Initialize default markets
	engine.initializeMarkets()
	
	// Start background processes
	go engine.interestRateUpdateLoop()
	go engine.liquidationCheckLoop()
	go engine.crossChainSyncLoop()
	go engine.revenueCalculationLoop()

	return engine
}

// initializeMarkets sets up initial lending markets
func (e *LendingEngine) initializeMarkets() {
	// Bitcoin lending market
	btcMarket := &LendingMarket{
		Asset:           "BTC",
		TotalSupply:     100.0,
		TotalBorrows:    50.0,
		UtilizationRate: 0.5,
		SupplyAPY:       0.05,
		BorrowAPY:       0.08,
		ReserveFactor:   0.1,
		CollateralFactor: 0.75,
		LastUpdate:      time.Now(),
		Reserves:        5.0,
		Users:           make(map[string]*UserPosition),
	}

	// Ethereum lending market
	ethMarket := &LendingMarket{
		Asset:           "ETH",
		TotalSupply:     1000.0,
		TotalBorrows:    600.0,
		UtilizationRate: 0.6,
		SupplyAPY:       0.06,
		BorrowAPY:       0.09,
		ReserveFactor:   0.1,
		CollateralFactor: 0.8,
		LastUpdate:      time.Now(),
		Reserves:        60.0,
		Users:           make(map[string]*UserPosition),
	}

	// USDT lending market
	usdtMarket := &LendingMarket{
		Asset:           "USDT",
		TotalSupply:     1000000.0,
		TotalBorrows:    700000.0,
		UtilizationRate: 0.7,
		SupplyAPY:       0.08,
		BorrowAPY:       0.12,
		ReserveFactor:   0.1,
		CollateralFactor: 0.9,
		LastUpdate:      time.Now(),
		Reserves:        70000.0,
		Users:           make(map[string]*UserPosition),
	}

	e.mutex.Lock()
	defer e.mutex.Unlock()
	
	e.markets["BTC"] = btcMarket
	e.markets["ETH"] = ethMarket
	e.markets["USDT"] = usdtMarket
}

// Supply deposits assets into a lending market
func (e *LendingEngine) Supply(asset string, amount float64, userAddress string) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	market, exists := e.markets[asset]
	if !exists {
		return fmt.Errorf("market %s not found", asset)
	}

	// Update market state
	market.TotalSupply += amount
	market.UtilizationRate = market.TotalBorrows / market.TotalSupply
	
	// Update user position
	userPos, exists := market.Users[userAddress]
	if !exists {
		userPos = &UserPosition{
			UserAddress:    userAddress,
			LastUpdate:     time.Now(),
		}
		market.Users[userAddress] = userPos
	}
	
	userPos.SuppliedAmount += amount
	userPos.LastUpdate = time.Now()
	
	// Update interest rates
	e.updateInterestRates(market)

	zap.L().Info("Supply deposited",
		zap.String("asset", asset),
		zap.Float64("amount", amount),
		zap.String("user", userAddress),
	)

	return nil
}

// Borrow borrows assets from a lending market
func (e *LendingEngine) Borrow(asset string, amount float64, userAddress string) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	market, exists := e.markets[asset]
	if !exists {
		return fmt.Errorf("market %s not found", asset)
	}

	userPos, exists := market.Users[userAddress]
	if !exists {
		return fmt.Errorf("user position not found")
	}

	// Check collateral requirements
	maxBorrow := userPos.CollateralValue * market.CollateralFactor
	if userPos.BorrowedAmount+amount > maxBorrow {
		return fmt.Errorf("insufficient collateral")
	}

	// Check market liquidity
	if amount > market.TotalSupply-market.TotalBorrows {
		return fmt.Errorf("insufficient market liquidity")
	}

	// Update market state
	market.TotalBorrows += amount
	market.UtilizationRate = market.TotalBorrows / market.TotalSupply
	
	// Update user position
	userPos.BorrowedAmount += amount
	userPos.LastUpdate = time.Now()
	
	// Update interest rates
	e.updateInterestRates(market)

	zap.L().Info("Assets borrowed",
		zap.String("asset", asset),
		zap.Float64("amount", amount),
		zap.String("user", userAddress),
	)

	return nil
}

// Repay repays borrowed assets
func (e *LendingEngine) Repay(asset string, amount float64, userAddress string) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	market, exists := e.markets[asset]
	if !exists {
		return fmt.Errorf("market %s not found", asset)
	}

	userPos, exists := market.Users[userAddress]
	if !exists {
		return fmt.Errorf("user position not found")
	}

	if amount > userPos.BorrowedAmount {
		amount = userPos.BorrowedAmount
	}

	// Update market state
	market.TotalBorrows -= amount
	market.UtilizationRate = market.TotalBorrows / market.TotalSupply
	
	// Update user position
	userPos.BorrowedAmount -= amount
	userPos.LastUpdate = time.Now()
	
	// Update interest rates
	e.updateInterestRates(market)

	zap.L().Info("Borrow repaid",
		zap.String("asset", asset),
		zap.Float64("amount", amount),
		zap.String("user", userAddress),
	)

	return nil
}

// Withdraw withdraws supplied assets
func (e *LendingEngine) Withdraw(asset string, amount float64, userAddress string) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	market, exists := e.markets[asset]
	if !exists {
		return fmt.Errorf("market %s not found", asset)
	}

	userPos, exists := market.Users[userAddress]
	if !exists {
		return fmt.Errorf("user position not found")
	}

	if amount > userPos.SuppliedAmount {
		return fmt.Errorf("insufficient supplied amount")
	}

	// Check withdrawal safety
	maxWithdraw := userPos.SuppliedAmount - (userPos.BorrowedAmount / market.CollateralFactor)
	if amount > maxWithdraw {
		return fmt.Errorf("withdrawal would reduce health factor below safe level")
	}

	// Update market state
	market.TotalSupply -= amount
	market.UtilizationRate = market.TotalBorrows / market.TotalSupply
	
	// Update user position
	userPos.SuppliedAmount -= amount
	userPos.LastUpdate = time.Now()
	
	// Update interest rates
	e.updateInterestRates(market)

	zap.L().Info("Supply withdrawn",
		zap.String("asset", asset),
		zap.Float64("amount", amount),
		zap.String("user", userAddress),
	)

	return nil
}

// AddCollateral adds collateral to a user's position
func (e *LendingEngine) AddCollateral(asset string, amount float64, userAddress string) error {
	return e.collateralMgr.AddCollateral(asset, amount, userAddress)
}

// updateInterestRates updates interest rates based on utilization
func (e *LendingEngine) updateInterestRates(market *LendingMarket) {
	utilization := market.UtilizationRate
	
	// Calculate supply APY
	supplyAPY := e.interestModel.GetSupplyRate(utilization)
	market.SupplyAPY = supplyAPY
	
	// Calculate borrow APY
	borrowAPY := e.interestModel.GetBorrowRate(utilization)
	market.BorrowAPY = borrowAPY
	
	market.LastUpdate = time.Now()
}

// GetMarketStats returns market statistics
func (e *LendingEngine) GetMarketStats(asset string) map[string]interface{} {
	e.mutex.RLock()
	defer e.mutex.RUnlock()

	market, exists := e.markets[asset]
	if !exists {
		return nil
	}

	return map[string]interface{}{
		"asset":            market.Asset,
		"total_supply":     market.TotalSupply,
		"total_borrows":    market.TotalBorrows,
		"utilization_rate": market.UtilizationRate,
		"supply_apy":       market.SupplyAPY,
		"borrow_apy":       market.BorrowAPY,
		"reserve_factor":   market.ReserveFactor,
		"last_update":      market.LastUpdate,
	}
}

// interestRateUpdateLoop periodically updates interest rates
func (e *LendingEngine) interestRateUpdateLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.updateAllInterestRates()
		}
	}
}

// updateAllInterestRates updates interest rates for all markets
func (e *LendingEngine) updateAllInterestRates() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	for _, market := range e.markets {
		e.updateInterestRates(market)
	}
}

// liquidationCheckLoop monitors for liquidations
func (e *LendingEngine) liquidationCheckLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.checkForLiquidations()
		}
	}
}

// checkForLiquidations checks for undercollateralized positions
func (e *LendingEngine) checkForLiquidations() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	for _, market := range e.markets {
		for userAddress, userPos := range market.Users {
			if userPos.HealthFactor < 1.0 {
				// Queue for liquidation
				request := &LiquidationRequest{
					UserAddress:    userAddress,
					Asset:          market.Asset,
					Amount:         userPos.BorrowedAmount,
					CollateralAsset: "BTC", // Simplified
					Timestamp:      time.Now(),
					Status:         "pending",
				}
				
				e.liquidationEng.QueueLiquidation(request)
			}
		}
	}
}

// NewCollateralManager creates a new collateral manager
func NewCollateralManager() *CollateralManager {
	return &CollateralManager{
		collateralAssets: make(map[string]*CollateralAsset),
		userCollateral:   make(map[string]map[string]float64),
		liquidationThreshold: 1.1,
	}
}

// NewInterestRateModel creates a new interest rate model
func NewInterestRateModel() *InterestRateModel {
	return &InterestRateModel{
		baseRatePerYear:       0.02,
		multiplierPerYear:     0.1,
		jumpMultiplierPerYear: 0.5,
		kink:                  0.8,
	}
}

// NewLiquidationEngine creates a new liquidation engine
func NewLiquidationEngine() *LiquidationEngine {
	return &LiquidationEngine{
		liquidationIncentives: 0.05,
		closeFactor:           0.5,
		liquidationQueue:      make([]*LiquidationRequest, 0),
	}
}

// AddCollateral adds collateral to a user's position
func (cm *CollateralManager) AddCollateral(asset string, amount float64, userAddress string) error {
	cm.mutex.Lock()
	defer cm.mutex.Unlock()

	if _, exists := cm.userCollateral[userAddress]; !exists {
		cm.userCollateral[userAddress] = make(map[string]float64)
	}
	
	cm.userCollateral[userAddress][asset] += amount
	
	return nil
}

// GetSupplyRate calculates supply rate based on utilization
func (irm *InterestRateModel) GetSupplyRate(utilization float64) float64 {
	if utilization <= irm.kink {
		return irm.baseRatePerYear + utilization*irm.multiplierPerYear
	}
	
	normalRate := irm.baseRatePerYear + irm.kink*irm.multiplierPerYear
	excessUtilization := utilization - irm.kink
	return normalRate + excessUtilization*irm.jumpMultiplierPerYear
}

// GetBorrowRate calculates borrow rate based on utilization
func (irm *InterestRateModel) GetBorrowRate(utilization float64) float64 {
	if utilization <= irm.kink {
		return irm.baseRatePerYear + utilization*irm.multiplierPerYear
	}
	
	normalRate := irm.baseRatePerYear + irm.kink*irm.multiplierPerYear
	excessUtilization := utilization - irm.kink
	return normalRate + excessUtilization*irm.jumpMultiplierPerYear
}

// QueueLiquidation adds a liquidation request to the queue
func (le *LiquidationEngine) QueueLiquidation(request *LiquidationRequest) {
	le.mutex.Lock()
	defer le.mutex.Unlock()
	
	le.liquidationQueue = append(le.liquidationQueue, request)
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

// NewCrossChainManager creates a new cross-chain manager
func NewCrossChainManager() *CrossChainManager {
	return &CrossChainManager{
		bridgeContracts: make(map[string]string),
		supportedChains: make(map[string]*ChainConfig),
		wrappedAssets:   make(map[string]string),
	}
}

// GetStats returns lending engine statistics
func (e *LendingEngine) GetStats() map[string]interface{} {
	e.mutex.RLock()
	defer e.mutex.RUnlock()

	stats := make(map[string]interface{})
	totalValueLocked := 0.0
	totalBorrows := 0.0
	
	for asset, market := range e.markets {
		stats[asset] = map[string]interface{}{
			"total_supply":     market.TotalSupply,
			"total_borrows":    market.TotalBorrows,
			"utilization_rate": market.UtilizationRate,
			"supply_apy":       market.SupplyAPY,
			"borrow_apy":       market.BorrowAPY,
		}
		totalValueLocked += market.TotalSupply
		totalBorrows += market.TotalBorrows
	}
	
	stats["total_value_locked"] = totalValueLocked
	stats["total_borrows"] = totalBorrows
	stats["user_count"] = len(e.markets["BTC"].Users) // Simplified

	return stats
}
