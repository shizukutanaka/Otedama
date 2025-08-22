package asic

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

type ASICType string

const (
	ASICTypeBitmain     ASICType = "bitmain"
	ASICTypeWhatsminer  ASICType = "whatsminer"
	ASICTypeCanaan      ASICType = "canaan"
	ASICTypeInnosilicon ASICType = "innosilicon"
)

type ASICMiner struct {
	ID           string
	Type         ASICType
	Model        string
	IPAddress    string
	Port         int
	Username     string
	Password     string
	Hashrate     float64
	Temperature  float64
	FanSpeed     int
	PowerUsage   float64
	Status       string
	LastSeen     time.Time
	mu           sync.RWMutex
}

func (a *ASICMiner) GetStatus() map[string]interface{} {
	a.mu.RLock()
	defer a.mu.RUnlock()
	
	return map[string]interface{}{
		"id":          a.ID,
		"type":        a.Type,
		"model":       a.Model,
		"hashrate":    a.Hashrate,
		"temperature": a.Temperature,
		"fan_speed":   a.FanSpeed,
		"power_usage": a.PowerUsage,
		"status":      a.Status,
		"last_seen":   a.LastSeen,
	}
}

type ASICManager struct {
	logger  *zap.Logger
	miners  map[string]*ASICMiner
	mu      sync.RWMutex
}

func NewASICManager(logger *zap.Logger) *ASICManager {
	return &ASICManager{
		logger: logger,
		miners: make(map[string]*ASICMiner),
	}
}

func (m *ASICManager) AddMiner(miner *ASICMiner) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	if _, exists := m.miners[miner.ID]; exists {
		return fmt.Errorf("miner %s already exists", miner.ID)
	}
	
	m.miners[miner.ID] = miner
	m.logger.Info("Added ASIC miner", zap.String("id", miner.ID), zap.String("model", miner.Model))
	return nil
}

func (m *ASICManager) RemoveMiner(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	if _, exists := m.miners[id]; !exists {
		return fmt.Errorf("miner %s not found", id)
	}
	
	delete(m.miners, id)
	m.logger.Info("Removed ASIC miner", zap.String("id", id))
	return nil
}

func (m *ASICManager) GetMiner(id string) (*ASICMiner, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	miner, exists := m.miners[id]
	if !exists {
		return nil, fmt.Errorf("miner %s not found", id)
	}
	
	return miner, nil
}

func (m *ASICManager) GetAllMiners() []*ASICMiner {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	miners := make([]*ASICMiner, 0, len(m.miners))
	for _, miner := range m.miners {
		miners = append(miners, miner)
	}
	
	return miners
}

func (m *ASICManager) Start(ctx context.Context) error {
	go m.monitorLoop(ctx)
	return nil
}

func (m *ASICManager) monitorLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.checkMiners()
		}
	}
}

func (m *ASICManager) checkMiners() {
	m.mu.RLock()
	miners := make([]*ASICMiner, 0, len(m.miners))
	for _, miner := range m.miners {
		miners = append(miners, miner)
	}
	m.mu.RUnlock()
	
	for _, miner := range miners {
		// Check miner status
		if time.Since(miner.LastSeen) > 2*time.Minute {
			miner.mu.Lock()
			miner.Status = "offline"
			miner.mu.Unlock()
			m.logger.Warn("ASIC miner offline", zap.String("id", miner.ID))
		}
	}
}

func (m *ASICManager) GetTotalHashrate() float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	var total float64
	for _, miner := range m.miners {
		miner.mu.RLock()
		total += miner.Hashrate
		miner.mu.RUnlock()
	}
	
	return total
}