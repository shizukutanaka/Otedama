package tracing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"
)

// DistributedTracer provides distributed tracing across P2P network
type DistributedTracer struct {
	// Trace storage
	traces      map[string]*Trace
	spans       map[string]*Span
	tracesMu    sync.RWMutex
	
	// Configuration
	config      *TracerConfig
	
	// Sampling
	sampler     Sampler
	
	// Export
	exporters   []Exporter
	exportQueue chan *Span
	
	// Statistics
	totalTraces atomic.Uint64
	totalSpans  atomic.Uint64
	droppedSpans atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Trace represents a distributed trace
type Trace struct {
	TraceID      string
	RootSpan     *Span
	Spans        []*Span
	StartTime    time.Time
	EndTime      time.Time
	Tags         map[string]string
	Sampled      bool
}

// Span represents a span in a trace
type Span struct {
	SpanID       string
	TraceID      string
	ParentSpanID string
	OperationName string
	
	// Timing
	StartTime    time.Time
	EndTime      time.Time
	Duration     time.Duration
	
	// Context
	ServiceName  string
	Resource     string
	SpanKind     SpanKind
	
	// Data
	Tags         map[string]string
	Logs         []LogEntry
	Status       SpanStatus
	
	// Network
	RemotePeerID string
	LocalPeerID  string
	
	// Metrics
	Metrics      map[string]float64
}

// SpanKind represents the type of span
type SpanKind int

const (
	SpanKindInternal SpanKind = iota
	SpanKindServer
	SpanKindClient
	SpanKindProducer
	SpanKindConsumer
)

// SpanStatus represents span completion status
type SpanStatus int

const (
	StatusOK SpanStatus = iota
	StatusCancelled
	StatusUnknown
	StatusInvalidArgument
	StatusDeadlineExceeded
	StatusNotFound
	StatusAlreadyExists
	StatusPermissionDenied
	StatusResourceExhausted
	StatusFailedPrecondition
	StatusAborted
	StatusOutOfRange
	StatusUnimplemented
	StatusInternal
	StatusUnavailable
	StatusDataLoss
	StatusUnauthenticated
)

// LogEntry represents a log entry in a span
type LogEntry struct {
	Timestamp time.Time
	Message   string
	Level     string
	Fields    map[string]interface{}
}

// TracerConfig holds tracer configuration
type TracerConfig struct {
	ServiceName    string
	SampleRate     float64
	MaxTraces      int
	MaxSpansPerTrace int
	ExportInterval time.Duration
	BufferSize     int
}

// Sampler decides whether to sample a trace
type Sampler interface {
	ShouldSample(traceID string) bool
}

// Exporter exports spans to external systems
type Exporter interface {
	Export(spans []*Span) error
	Name() string
}

// DefaultTracerConfig returns default configuration
func DefaultTracerConfig() *TracerConfig {
	return &TracerConfig{
		ServiceName:      "otedama",
		SampleRate:       0.1, // 10% sampling
		MaxTraces:        10000,
		MaxSpansPerTrace: 100,
		ExportInterval:   10 * time.Second,
		BufferSize:       1000,
	}
}

// NewDistributedTracer creates a new distributed tracer
func NewDistributedTracer(ctx context.Context, config *TracerConfig) *DistributedTracer {
	if config == nil {
		config = DefaultTracerConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	dt := &DistributedTracer{
		traces:      make(map[string]*Trace),
		spans:       make(map[string]*Span),
		config:      config,
		sampler:     NewProbabilitySampler(config.SampleRate),
		exporters:   make([]Exporter, 0),
		exportQueue: make(chan *Span, config.BufferSize),
		ctx:         ctx,
		cancel:      cancel,
	}
	
	// Start export worker
	dt.wg.Add(1)
	go dt.exportWorker()
	
	// Start cleanup worker
	dt.wg.Add(1)
	go dt.cleanupWorker()
	
	return dt
}

// StartTrace starts a new trace
func (dt *DistributedTracer) StartTrace(operationName string) *Span {
	traceID := generateTraceID()
	
	// Check sampling
	sampled := dt.sampler.ShouldSample(traceID)
	if !sampled {
		return nil // Don't trace if not sampled
	}
	
	// Create root span
	span := &Span{
		SpanID:        generateSpanID(),
		TraceID:       traceID,
		OperationName: operationName,
		StartTime:     time.Now(),
		ServiceName:   dt.config.ServiceName,
		SpanKind:      SpanKindInternal,
		Tags:          make(map[string]string),
		Logs:          make([]LogEntry, 0),
		Metrics:       make(map[string]float64),
	}
	
	// Create trace
	trace := &Trace{
		TraceID:   traceID,
		RootSpan:  span,
		Spans:     []*Span{span},
		StartTime: span.StartTime,
		Tags:      make(map[string]string),
		Sampled:   sampled,
	}
	
	// Store trace
	dt.tracesMu.Lock()
	if len(dt.traces) < dt.config.MaxTraces {
		dt.traces[traceID] = trace
		dt.spans[span.SpanID] = span
		dt.totalTraces.Add(1)
		dt.totalSpans.Add(1)
	}
	dt.tracesMu.Unlock()
	
	return span
}

// StartSpan starts a new span as child of parent
func (dt *DistributedTracer) StartSpan(parentSpan *Span, operationName string) *Span {
	if parentSpan == nil {
		return dt.StartTrace(operationName)
	}
	
	span := &Span{
		SpanID:        generateSpanID(),
		TraceID:       parentSpan.TraceID,
		ParentSpanID:  parentSpan.SpanID,
		OperationName: operationName,
		StartTime:     time.Now(),
		ServiceName:   dt.config.ServiceName,
		SpanKind:      SpanKindInternal,
		Tags:          make(map[string]string),
		Logs:          make([]LogEntry, 0),
		Metrics:       make(map[string]float64),
	}
	
	// Add to trace
	dt.tracesMu.Lock()
	if trace, exists := dt.traces[span.TraceID]; exists {
		if len(trace.Spans) < dt.config.MaxSpansPerTrace {
			trace.Spans = append(trace.Spans, span)
			dt.spans[span.SpanID] = span
			dt.totalSpans.Add(1)
		} else {
			dt.droppedSpans.Add(1)
			dt.tracesMu.Unlock()
			return nil
		}
	}
	dt.tracesMu.Unlock()
	
	return span
}

// FinishSpan finishes a span
func (dt *DistributedTracer) FinishSpan(span *Span) {
	if span == nil {
		return
	}
	
	span.EndTime = time.Now()
	span.Duration = span.EndTime.Sub(span.StartTime)
	
	// Queue for export
	select {
	case dt.exportQueue <- span:
	default:
		dt.droppedSpans.Add(1)
	}
	
	// Update trace end time
	dt.tracesMu.Lock()
	if trace, exists := dt.traces[span.TraceID]; exists {
		if span.SpanID == trace.RootSpan.SpanID {
			trace.EndTime = span.EndTime
		}
	}
	dt.tracesMu.Unlock()
}

// SetTag sets a tag on a span
func (dt *DistributedTracer) SetTag(span *Span, key, value string) {
	if span == nil {
		return
	}
	span.Tags[key] = value
}

// SetMetric sets a metric on a span
func (dt *DistributedTracer) SetMetric(span *Span, key string, value float64) {
	if span == nil {
		return
	}
	span.Metrics[key] = value
}

// AddLog adds a log entry to a span
func (dt *DistributedTracer) AddLog(span *Span, message string, fields map[string]interface{}) {
	if span == nil {
		return
	}
	
	log := LogEntry{
		Timestamp: time.Now(),
		Message:   message,
		Level:     "info",
		Fields:    fields,
	}
	
	span.Logs = append(span.Logs, log)
}

// SetStatus sets the status of a span
func (dt *DistributedTracer) SetStatus(span *Span, status SpanStatus) {
	if span == nil {
		return
	}
	span.Status = status
}

// AddExporter adds an exporter
func (dt *DistributedTracer) AddExporter(exporter Exporter) {
	dt.exporters = append(dt.exporters, exporter)
}

// exportWorker exports spans to external systems
func (dt *DistributedTracer) exportWorker() {
	defer dt.wg.Done()
	
	ticker := time.NewTicker(dt.config.ExportInterval)
	defer ticker.Stop()
	
	batch := make([]*Span, 0, 100)
	
	for {
		select {
		case span := <-dt.exportQueue:
			batch = append(batch, span)
			
			// Export if batch is full
			if len(batch) >= 100 {
				dt.exportBatch(batch)
				batch = batch[:0]
			}
			
		case <-ticker.C:
			// Periodic export
			if len(batch) > 0 {
				dt.exportBatch(batch)
				batch = batch[:0]
			}
			
		case <-dt.ctx.Done():
			// Export remaining spans
			if len(batch) > 0 {
				dt.exportBatch(batch)
			}
			return
		}
	}
}

// exportBatch exports a batch of spans
func (dt *DistributedTracer) exportBatch(spans []*Span) {
	for _, exporter := range dt.exporters {
		if err := exporter.Export(spans); err != nil {
			// Log error but continue
			fmt.Printf("Failed to export to %s: %v\n", exporter.Name(), err)
		}
	}
}

// cleanupWorker cleans up old traces
func (dt *DistributedTracer) cleanupWorker() {
	defer dt.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dt.cleanup()
			
		case <-dt.ctx.Done():
			return
		}
	}
}

// cleanup removes old traces
func (dt *DistributedTracer) cleanup() {
	dt.tracesMu.Lock()
	defer dt.tracesMu.Unlock()
	
	now := time.Now()
	for traceID, trace := range dt.traces {
		// Remove traces older than 1 hour
		if now.Sub(trace.StartTime) > 1*time.Hour {
			// Remove spans
			for _, span := range trace.Spans {
				delete(dt.spans, span.SpanID)
			}
			delete(dt.traces, traceID)
		}
	}
}

// GetTrace returns a trace by ID
func (dt *DistributedTracer) GetTrace(traceID string) (*Trace, bool) {
	dt.tracesMu.RLock()
	defer dt.tracesMu.RUnlock()
	
	trace, exists := dt.traces[traceID]
	return trace, exists
}

// GetStatistics returns tracer statistics
func (dt *DistributedTracer) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	dt.tracesMu.RLock()
	stats["active_traces"] = len(dt.traces)
	stats["active_spans"] = len(dt.spans)
	dt.tracesMu.RUnlock()
	
	stats["total_traces"] = dt.totalTraces.Load()
	stats["total_spans"] = dt.totalSpans.Load()
	stats["dropped_spans"] = dt.droppedSpans.Load()
	
	return stats
}

// Stop stops the tracer
func (dt *DistributedTracer) Stop() {
	dt.cancel()
	dt.wg.Wait()
}

// ProbabilitySampler samples based on probability
type ProbabilitySampler struct {
	probability float64
}

// NewProbabilitySampler creates a probability sampler
func NewProbabilitySampler(probability float64) *ProbabilitySampler {
	return &ProbabilitySampler{probability: probability}
}

// ShouldSample decides whether to sample
func (ps *ProbabilitySampler) ShouldSample(traceID string) bool {
	return rand.Float64() < ps.probability
}

// AlwaysSampler always samples
type AlwaysSampler struct{}

// ShouldSample always returns true
func (as *AlwaysSampler) ShouldSample(traceID string) bool {
	return true
}

// NeverSampler never samples
type NeverSampler struct{}

// ShouldSample always returns false
func (ns *NeverSampler) ShouldSample(traceID string) bool {
	return false
}

// RateLimitedSampler samples with rate limiting
type RateLimitedSampler struct {
	maxPerSecond int
	tokens       atomic.Int32
	lastRefill   atomic.Value // time.Time
	mu           sync.Mutex
}

// NewRateLimitedSampler creates a rate limited sampler
func NewRateLimitedSampler(maxPerSecond int) *RateLimitedSampler {
	sampler := &RateLimitedSampler{
		maxPerSecond: maxPerSecond,
	}
	sampler.tokens.Store(int32(maxPerSecond))
	sampler.lastRefill.Store(time.Now())
	return sampler
}

// ShouldSample decides whether to sample
func (rs *RateLimitedSampler) ShouldSample(traceID string) bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	
	// Refill tokens
	now := time.Now()
	lastRefill := rs.lastRefill.Load().(time.Time)
	elapsed := now.Sub(lastRefill).Seconds()
	
	if elapsed >= 1.0 {
		rs.tokens.Store(int32(rs.maxPerSecond))
		rs.lastRefill.Store(now)
	}
	
	// Check tokens
	tokens := rs.tokens.Load()
	if tokens > 0 {
		rs.tokens.Add(-1)
		return true
	}
	
	return false
}

// ConsoleExporter exports to console
type ConsoleExporter struct{}

// Export prints spans to console
func (ce *ConsoleExporter) Export(spans []*Span) error {
	for _, span := range spans {
		fmt.Printf("[TRACE] %s: %s (%.2fms)\n",
			span.TraceID[:8],
			span.OperationName,
			float64(span.Duration.Microseconds())/1000.0)
	}
	return nil
}

// Name returns exporter name
func (ce *ConsoleExporter) Name() string {
	return "console"
}

// generateTraceID generates a trace ID
func generateTraceID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// generateSpanID generates a span ID
func generateSpanID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// TracingMiddleware provides tracing for operations
type TracingMiddleware struct {
	tracer *DistributedTracer
}

// NewTracingMiddleware creates tracing middleware
func NewTracingMiddleware(tracer *DistributedTracer) *TracingMiddleware {
	return &TracingMiddleware{tracer: tracer}
}

// Trace wraps a function with tracing
func (tm *TracingMiddleware) Trace(operationName string, fn func(context.Context) error) error {
	span := tm.tracer.StartTrace(operationName)
	if span == nil {
		return fn(context.Background())
	}
	
	defer tm.tracer.FinishSpan(span)
	
	ctx := context.WithValue(context.Background(), "span", span)
	err := fn(ctx)
	
	if err != nil {
		tm.tracer.SetStatus(span, StatusInternal)
		tm.tracer.SetTag(span, "error", err.Error())
	} else {
		tm.tracer.SetStatus(span, StatusOK)
	}
	
	return err
}

// P2PTracer provides P2P-specific tracing
type P2PTracer struct {
	tracer *DistributedTracer
}

// NewP2PTracer creates P2P tracer
func NewP2PTracer(tracer *DistributedTracer) *P2PTracer {
	return &P2PTracer{tracer: tracer}
}

// TraceMessage traces a P2P message
func (pt *P2PTracer) TraceMessage(msgType string, peerID string, size int) *Span {
	span := pt.tracer.StartTrace(fmt.Sprintf("p2p.%s", msgType))
	if span == nil {
		return nil
	}
	
	span.SpanKind = SpanKindClient
	span.RemotePeerID = peerID
	pt.tracer.SetTag(span, "message.type", msgType)
	pt.tracer.SetMetric(span, "message.size", float64(size))
	
	return span
}

// TraceRPC traces an RPC call
func (pt *P2PTracer) TraceRPC(method string, peerID string) *Span {
	span := pt.tracer.StartTrace(fmt.Sprintf("rpc.%s", method))
	if span == nil {
		return nil
	}
	
	span.SpanKind = SpanKindClient
	span.RemotePeerID = peerID
	pt.tracer.SetTag(span, "rpc.method", method)
	
	return span
}

// MiningTracer provides mining-specific tracing
type MiningTracer struct {
	tracer *DistributedTracer
}

// NewMiningTracer creates mining tracer
func NewMiningTracer(tracer *DistributedTracer) *MiningTracer {
	return &MiningTracer{tracer: tracer}
}

// TraceJob traces a mining job
func (mt *MiningTracer) TraceJob(jobID string, algorithm string) *Span {
	span := mt.tracer.StartTrace("mining.job")
	if span == nil {
		return nil
	}
	
	mt.tracer.SetTag(span, "job.id", jobID)
	mt.tracer.SetTag(span, "algorithm", algorithm)
	
	return span
}

// TraceShare traces a share submission
func (mt *MiningTracer) TraceShare(jobID string, difficulty float64, valid bool) *Span {
	span := mt.tracer.StartTrace("mining.share")
	if span == nil {
		return nil
	}
	
	mt.tracer.SetTag(span, "job.id", jobID)
	mt.tracer.SetMetric(span, "difficulty", difficulty)
	mt.tracer.SetTag(span, "valid", fmt.Sprintf("%v", valid))
	
	return span
}