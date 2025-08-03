package common

import (
    "sync/atomic"
    "time"
)

// UnifiedStats provides thread-safe statistics for all components
type UnifiedStats struct {
    // Basic info
    StartTime time.Time
    Name      string
    
    // Counters (use atomic operations)
    TotalCount    atomic.Uint64
    SuccessCount  atomic.Uint64
    FailureCount  atomic.Uint64
    
    // Performance metrics
    TotalDuration atomic.Int64  // nanoseconds
    LastDuration  atomic.Int64  // nanoseconds
    
    // Network stats
    BytesReceived atomic.Uint64
    BytesSent     atomic.Uint64
    
    // Mining specific
    HashRate      atomic.Uint64
    SharesFound   atomic.Uint64
    SharesAccepted atomic.Uint64
    SharesRejected atomic.Uint64
    
    // Connection stats
    ActiveConnections atomic.Int32
    TotalConnections  atomic.Uint64
}

// NewUnifiedStats creates a new stats instance
func NewUnifiedStats(name string) *UnifiedStats {
    return &UnifiedStats{
        StartTime: time.Now(),
        Name:      name,
    }
}

// IncrementSuccess increments success counter
func (s *UnifiedStats) IncrementSuccess() {
    s.TotalCount.Add(1)
    s.SuccessCount.Add(1)
}

// IncrementFailure increments failure counter
func (s *UnifiedStats) IncrementFailure() {
    s.TotalCount.Add(1)
    s.FailureCount.Add(1)
}

// RecordDuration records operation duration
func (s *UnifiedStats) RecordDuration(duration time.Duration) {
    ns := duration.Nanoseconds()
    s.LastDuration.Store(ns)
    s.TotalDuration.Add(ns)
}

// AddBytes adds to byte counters
func (s *UnifiedStats) AddBytes(received, sent uint64) {
    if received > 0 {
        s.BytesReceived.Add(received)
    }
    if sent > 0 {
        s.BytesSent.Add(sent)
    }
}

// UpdateHashRate updates the hash rate
func (s *UnifiedStats) UpdateHashRate(rate uint64) {
    s.HashRate.Store(rate)
}

// AddShare records a share submission
func (s *UnifiedStats) AddShare(accepted bool) {
    s.SharesFound.Add(1)
    if accepted {
        s.SharesAccepted.Add(1)
    } else {
        s.SharesRejected.Add(1)
    }
}

// UpdateConnections updates connection count
func (s *UnifiedStats) UpdateConnections(delta int32) {
    if delta > 0 {
        s.TotalConnections.Add(uint64(delta))
    }
    s.ActiveConnections.Add(delta)
}

// GetSnapshot returns a snapshot of current stats
func (s *UnifiedStats) GetSnapshot() map[string]interface{} {
    uptime := time.Since(s.StartTime)
    totalCount := s.TotalCount.Load()
    successCount := s.SuccessCount.Load()
    failureCount := s.FailureCount.Load()
    
    successRate := float64(0)
    if totalCount > 0 {
        successRate = float64(successCount) / float64(totalCount) * 100
    }
    
    avgDuration := time.Duration(0)
    if totalCount > 0 {
        avgDuration = time.Duration(s.TotalDuration.Load() / int64(totalCount))
    }
    
    return map[string]interface{}{
        "name":               s.Name,
        "uptime_seconds":     uptime.Seconds(),
        "total_operations":   totalCount,
        "success_count":      successCount,
        "failure_count":      failureCount,
        "success_rate":       successRate,
        "avg_duration_ms":    avgDuration.Milliseconds(),
        "last_duration_ms":   time.Duration(s.LastDuration.Load()).Milliseconds(),
        "bytes_received":     s.BytesReceived.Load(),
        "bytes_sent":         s.BytesSent.Load(),
        "hash_rate":          s.HashRate.Load(),
        "shares_found":       s.SharesFound.Load(),
        "shares_accepted":    s.SharesAccepted.Load(),
        "shares_rejected":    s.SharesRejected.Load(),
        "active_connections": s.ActiveConnections.Load(),
        "total_connections":  s.TotalConnections.Load(),
    }
}

// Reset resets all counters except StartTime
func (s *UnifiedStats) Reset() {
    s.TotalCount.Store(0)
    s.SuccessCount.Store(0)
    s.FailureCount.Store(0)
    s.TotalDuration.Store(0)
    s.LastDuration.Store(0)
    s.BytesReceived.Store(0)
    s.BytesSent.Store(0)
    s.SharesFound.Store(0)
    s.SharesAccepted.Store(0)
    s.SharesRejected.Store(0)
}