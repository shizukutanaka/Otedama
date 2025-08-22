package profit

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
)

type ProfitCalculator struct {
	logger         *zap.Logger
	currentCoin    string
	profitData     map[string]float64
	mu             sync.RWMutex
	updateInterval time.Duration
}

func NewProfitCalculator(logger *zap.Logger) *ProfitCalculator {
	return &ProfitCalculator{
		logger:         logger,
		currentCoin:    "BTC",
		profitData:     make(map[string]float64),
		updateInterval: 5 * time.Minute,
	}
}

func (p *ProfitCalculator) Start(ctx context.Context) error {
	go p.updateLoop(ctx)
	return nil
}

func (p *ProfitCalculator) updateLoop(ctx context.Context) {
	ticker := time.NewTicker(p.updateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.updateProfitData()
		}
	}
}

func (p *ProfitCalculator) updateProfitData() {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	// Placeholder profit calculations
	p.profitData["BTC"] = 100.0
	p.profitData["ETH"] = 95.0
	p.profitData["LTC"] = 85.0
	p.profitData["XMR"] = 80.0
	
	p.logger.Debug("Updated profit data", zap.Any("data", p.profitData))
}

func (p *ProfitCalculator) GetMostProfitable() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	var bestCoin string
	var bestProfit float64
	
	for coin, profit := range p.profitData {
		if profit > bestProfit {
			bestProfit = profit
			bestCoin = coin
		}
	}
	
	return bestCoin
}

func (p *ProfitCalculator) GetProfitability(coin string) float64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	return p.profitData[coin]
}

func (p *ProfitCalculator) SetCurrentCoin(coin string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	p.currentCoin = coin
	p.logger.Info("Switched to coin", zap.String("coin", coin))
}

func (p *ProfitCalculator) GetCurrentCoin() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	return p.currentCoin
}

type ProfitSwitcher struct {
	calculator     *ProfitCalculator
	logger         *zap.Logger
	switchCallback func(string) error
}

func NewProfitSwitcher(calc *ProfitCalculator, logger *zap.Logger) *ProfitSwitcher {
	return &ProfitSwitcher{
		calculator: calc,
		logger:     logger,
	}
}

func (ps *ProfitSwitcher) SetSwitchCallback(cb func(string) error) {
	ps.switchCallback = cb
}

func (ps *ProfitSwitcher) CheckAndSwitch() error {
	bestCoin := ps.calculator.GetMostProfitable()
	currentCoin := ps.calculator.GetCurrentCoin()
	
	if bestCoin != currentCoin && bestCoin != "" {
		ps.logger.Info("Switching to more profitable coin", 
			zap.String("from", currentCoin),
			zap.String("to", bestCoin))
		
		if ps.switchCallback != nil {
			if err := ps.switchCallback(bestCoin); err != nil {
				return err
			}
		}
		
		ps.calculator.SetCurrentCoin(bestCoin)
	}
	
	return nil
}