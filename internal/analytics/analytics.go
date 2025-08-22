package analytics

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
)

type Analytics struct {
	logger  *zap.Logger
	metrics map[string]interface{}
	mu      sync.RWMutex
}

func NewAnalytics(logger *zap.Logger) *Analytics {
	return &Analytics{
		logger:  logger,
		metrics: make(map[string]interface{}),
	}
}

func (a *Analytics) TrackEvent(event string, properties map[string]interface{}) {
	a.mu.Lock()
	defer a.mu.Unlock()
	
	a.metrics[event] = properties
	a.logger.Debug("Event tracked", zap.String("event", event))
}

func (a *Analytics) GetMetrics() map[string]interface{} {
	a.mu.RLock()
	defer a.mu.RUnlock()
	
	result := make(map[string]interface{})
	for k, v := range a.metrics {
		result[k] = v
	}
	return result
}

type RealtimeAnalytics struct {
	*Analytics
	updateChan chan map[string]interface{}
}

func NewRealtimeAnalytics(logger *zap.Logger) *RealtimeAnalytics {
	return &RealtimeAnalytics{
		Analytics:  NewAnalytics(logger),
		updateChan: make(chan map[string]interface{}, 100),
	}
}

func (r *RealtimeAnalytics) Start(ctx context.Context) error {
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				metrics := r.GetMetrics()
				select {
				case r.updateChan <- metrics:
				default:
				}
			}
		}
	}()
	
	return nil
}

func (r *RealtimeAnalytics) GetUpdateChannel() <-chan map[string]interface{} {
	return r.updateChan
}