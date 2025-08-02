package profiling

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// LightweightProfiler provides minimal overhead profiling
// Following Rob Pike's principle: "Less is exponentially more"
type LightweightProfiler struct {
	logger *zap.Logger
	
	// Core metrics with atomic operations for lock-free access
	hashRate     atomic.Uint64
	shareCount   atomic.Uint64
	rejectCount  atomic.Uint64
	temperature  atomic.Uint32 // Stored as celsius * 100
	
	// Memory metrics
	allocBytes   atomic.Uint64
	allocObjects atomic.Uint64
	gcPauseNs    atomic.Uint64
	
	// Circular buffer for recent samples (lock-free)
	samples      [1024]Sample // Power of 2 for fast modulo
	sampleIndex  atomic.Uint32
	
	// Minimal state
	running      atomic.Bool
	startTime    time.Time
}

// Sample represents a lightweight performance sample
type Sample struct {
	Timestamp   int64  // Unix nano
	HashRate    uint64 
	ShareRate   uint64
	Temperature uint32
	MemAlloc    uint64
	Goroutines  uint32
}

// NewLightweightProfiler creates a minimal overhead profiler
func NewLightweightProfiler(logger *zap.Logger) *LightweightProfiler {
	return &LightweightProfiler{
		logger:    logger,
		startTime: time.Now(),
	}
}

// Start begins lightweight profiling
func (p *LightweightProfiler) Start(ctx context.Context) error {
	if !p.running.CompareAndSwap(false, true) {
		return nil // Already running
	}
	
	go p.collectLoop(ctx)
	return nil
}

// Stop halts profiling
func (p *LightweightProfiler) Stop() {
	p.running.Store(false)
}

// collectLoop runs the minimal collection routine
func (p *LightweightProfiler) collectLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	var m runtime.MemStats
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !p.running.Load() {
				return
			}
			
			// Collect sample with minimal overhead
			runtime.ReadMemStats(&m)
			
			sample := Sample{
				Timestamp:   time.Now().UnixNano(),
				HashRate:    p.hashRate.Load(),
				ShareRate:   p.shareCount.Load(),
				Temperature: p.temperature.Load(),
				MemAlloc:    m.Alloc,
				Goroutines:  uint32(runtime.NumGoroutine()),
			}
			
			// Store in circular buffer (lock-free)
			idx := p.sampleIndex.Add(1) & 1023
			p.samples[idx] = sample
			
			// Update GC pause time
			if m.NumGC > 0 && len(m.PauseNs) > 0 {
				p.gcPauseNs.Store(m.PauseNs[(m.NumGC+255)%256])
			}
		}
	}
}

// UpdateHashRate updates the current hash rate
func (p *LightweightProfiler) UpdateHashRate(rate uint64) {
	p.hashRate.Store(rate)
}

// RecordShare records a share submission
func (p *LightweightProfiler) RecordShare(accepted bool) {
	p.shareCount.Add(1)
	if !accepted {
		p.rejectCount.Add(1)
	}
}

// UpdateTemperature updates the current temperature
func (p *LightweightProfiler) UpdateTemperature(celsius float32) {
	p.temperature.Store(uint32(celsius * 100))
}

// GetStats returns current statistics without allocation
func (p *LightweightProfiler) GetStats() ProfileStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	shares := p.shareCount.Load()
	rejects := p.rejectCount.Load()
	
	return ProfileStats{
		Uptime:       time.Since(p.startTime),
		HashRate:     p.hashRate.Load(),
		ShareRate:    shares,
		RejectRate:   rejects,
		Temperature:  float32(p.temperature.Load()) / 100,
		MemoryUsage:  m.Alloc,
		GCPauseNs:    p.gcPauseNs.Load(),
		Goroutines:   runtime.NumGoroutine(),
	}
}

// GetRecentSamples returns recent samples without copying
func (p *LightweightProfiler) GetRecentSamples(count int) []Sample {
	if count > 1024 {
		count = 1024
	}
	
	current := p.sampleIndex.Load()
	samples := make([]Sample, 0, count)
	
	for i := 0; i < count; i++ {
		idx := (current - uint32(i)) & 1023
		sample := p.samples[idx]
		if sample.Timestamp > 0 {
			samples = append(samples, sample)
		}
	}
	
	return samples
}

// ProfileStats contains minimal profiling statistics
type ProfileStats struct {
	Uptime       time.Duration
	HashRate     uint64
	ShareRate    uint64
	RejectRate   uint64
	Temperature  float32
	MemoryUsage  uint64
	GCPauseNs    uint64
	Goroutines   int
}

// Reset clears all counters
func (p *LightweightProfiler) Reset() {
	p.shareCount.Store(0)
	p.rejectCount.Store(0)
	p.startTime = time.Now()
}