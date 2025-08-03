package hardware

import (
    "context"
    "sync"
    "time"
    
    "github.com/shizukutanaka/Otedama/internal/common"
    "github.com/shirou/gopsutil/v3/cpu"
    "github.com/shirou/gopsutil/v3/mem"
    "go.uber.org/zap"
)

// UnifiedMonitor combines all hardware monitoring
type UnifiedMonitor struct {
    logger *zap.Logger
    stats  *common.UnifiedStats
    
    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup
}

// NewUnifiedMonitor creates a new hardware monitor
func NewUnifiedMonitor(logger *zap.Logger) *UnifiedMonitor {
    ctx, cancel := context.WithCancel(context.Background())
    return &UnifiedMonitor{
        logger: logger,
        stats:  common.NewUnifiedStats("hardware"),
        ctx:    ctx,
        cancel: cancel,
    }
}

// Start starts monitoring
func (m *UnifiedMonitor) Start() error {
    m.logger.Info("Starting hardware monitor")
    
    m.wg.Add(1)
    go m.monitorLoop()
    
    return nil
}

// Stop stops monitoring
func (m *UnifiedMonitor) Stop() error {
    m.logger.Info("Stopping hardware monitor")
    m.cancel()
    m.wg.Wait()
    return nil
}

// GetStats returns current hardware stats
func (m *UnifiedMonitor) GetStats() map[string]interface{} {
    cpuPercent, _ := cpu.Percent(0, false)
    memInfo, _ := mem.VirtualMemory()
    
    stats := map[string]interface{}{
        "cpu_percent": cpuPercent,
        "memory_used_mb": memInfo.Used / 1024 / 1024,
        "memory_total_mb": memInfo.Total / 1024 / 1024,
        "memory_percent": memInfo.UsedPercent,
    }
    
    return stats
}

func (m *UnifiedMonitor) monitorLoop() {
    defer m.wg.Done()
    
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-m.ctx.Done():
            return
        case <-ticker.C:
            stats := m.GetStats()
            m.logger.Debug("Hardware stats", zap.Any("stats", stats))
        }
    }
}
