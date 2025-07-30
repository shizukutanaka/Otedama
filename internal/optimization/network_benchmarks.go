package optimization

import (
	"context"
	"crypto/rand"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/network"
	"github.com/otedama/otedama/internal/p2p"
	"go.uber.org/zap"
)

// NetworkBenchmarks provides network performance benchmarks
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type NetworkBenchmarks struct {
	logger *zap.Logger
	runner *BenchmarkRunner
}

// NewNetworkBenchmarks creates new network benchmarks
func NewNetworkBenchmarks(logger *zap.Logger) *NetworkBenchmarks {
	return &NetworkBenchmarks{
		logger: logger,
		runner: NewBenchmarkRunner(logger),
	}
}

// RunAllNetworkBenchmarks runs comprehensive network benchmarks
func (nb *NetworkBenchmarks) RunAllNetworkBenchmarks() (*NetworkBenchmarkReport, error) {
	report := &NetworkBenchmarkReport{
		Timestamp: time.Now(),
	}
	
	// Message throughput benchmark
	report.MessageThroughput = nb.benchmarkMessageThroughput()
	
	// Connection pool benchmark
	report.ConnectionPool = nb.benchmarkConnectionPool()
	
	// P2P broadcast benchmark
	report.P2PBroadcast = nb.benchmarkP2PBroadcast()
	
	// Latency benchmark
	report.NetworkLatency = nb.benchmarkNetworkLatency()
	
	// DDoS protection benchmark
	report.DDoSProtection = nb.benchmarkDDoSProtection()
	
	return report, nil
}

// benchmarkMessageThroughput tests message processing throughput
func (nb *NetworkBenchmarks) benchmarkMessageThroughput() *MessageThroughputBenchmark {
	nb.logger.Info("Benchmarking message throughput")
	
	var messagesSent atomic.Uint64
	var bytesTransferred atomic.Uint64
	
	// Create test messages of different sizes
	smallMsg := make([]byte, 256)    // 256B
	mediumMsg := make([]byte, 4096)  // 4KB
	largeMsg := make([]byte, 65536)  // 64KB
	
	rand.Read(smallMsg)
	rand.Read(mediumMsg)
	rand.Read(largeMsg)
	
	result, _ := nb.runner.RunBenchmark("message_throughput", func(ctx context.Context) error {
		// Simulate message processing
		msgType := messagesSent.Load() % 3
		
		switch msgType {
		case 0:
			processMessage(smallMsg)
			bytesTransferred.Add(uint64(len(smallMsg)))
		case 1:
			processMessage(mediumMsg)
			bytesTransferred.Add(uint64(len(mediumMsg)))
		case 2:
			processMessage(largeMsg)
			bytesTransferred.Add(uint64(len(largeMsg)))
		}
		
		messagesSent.Add(1)
		return nil
	})
	
	return &MessageThroughputBenchmark{
		MessagesPerSecond: float64(messagesSent.Load()) / result.Duration.Seconds(),
		BytesPerSecond:    float64(bytesTransferred.Load()) / result.Duration.Seconds(),
		AvgMessageSize:    float64(bytesTransferred.Load()) / float64(messagesSent.Load()),
		Result:            result,
	}
}

// benchmarkConnectionPool tests connection pool performance
func (nb *NetworkBenchmarks) benchmarkConnectionPool() *ConnectionPoolBenchmark {
	nb.logger.Info("Benchmarking connection pool")
	
	// Create test connection pool
	pool := network.NewConnectionPool("localhost:9999", 10, 100)
	defer pool.Close()
	
	var connectionsCreated atomic.Uint64
	var connectionsReused atomic.Uint64
	
	result, _ := nb.runner.RunBenchmark("connection_pool", func(ctx context.Context) error {
		// Get connection from pool
		conn, err := pool.Get(ctx)
		if err != nil {
			return err
		}
		
		// Track if this is a new or reused connection
		stats := pool.Stats()
		if stats.Open > int(connectionsCreated.Load()) {
			connectionsCreated.Add(1)
		} else {
			connectionsReused.Add(1)
		}
		
		// Simulate some work
		time.Sleep(time.Microsecond)
		
		// Return connection to pool
		return pool.Put(conn)
	})
	
	totalOps := connectionsCreated.Load() + connectionsReused.Load()
	
	return &ConnectionPoolBenchmark{
		ConnectionsPerSecond: float64(totalOps) / result.Duration.Seconds(),
		ReuseRatio:          float64(connectionsReused.Load()) / float64(totalOps),
		AvgGetLatency:       result.AvgLatency,
		Result:              result,
	}
}

// benchmarkP2PBroadcast tests P2P broadcast performance
func (nb *NetworkBenchmarks) benchmarkP2PBroadcast() *P2PBroadcastBenchmark {
	nb.logger.Info("Benchmarking P2P broadcast")
	
	var messagesBroadcast atomic.Uint64
	var peersReached atomic.Uint64
	
	// Simulate different network sizes
	networkSizes := []int{10, 50, 100, 500, 1000}
	
	result, _ := nb.runner.RunBenchmark("p2p_broadcast", func(ctx context.Context) error {
		// Select network size
		size := networkSizes[int(messagesBroadcast.Load())%len(networkSizes)]
		
		// Create test message
		msg := p2p.Message{
			Type:      p2p.MessageTypeBlock,
			Data:      make([]byte, 1024),
			Timestamp: time.Now().Unix(),
		}
		
		// Simulate broadcast to peers
		reached := simulateBroadcast(msg, size)
		
		messagesBroadcast.Add(1)
		peersReached.Add(uint64(reached))
		
		return nil
	})
	
	avgPeersReached := float64(peersReached.Load()) / float64(messagesBroadcast.Load())
	
	return &P2PBroadcastBenchmark{
		BroadcastsPerSecond: float64(messagesBroadcast.Load()) / result.Duration.Seconds(),
		AvgPeersReached:     avgPeersReached,
		BroadcastLatency:    result.AvgLatency,
		Result:              result,
	}
}

// benchmarkNetworkLatency tests network latency
func (nb *NetworkBenchmarks) benchmarkNetworkLatency() *NetworkLatencyBenchmark {
	nb.logger.Info("Benchmarking network latency")
	
	var pingSent atomic.Uint64
	var totalLatency atomic.Int64
	
	// Test different message sizes
	sizes := []int{64, 256, 1024, 4096}
	
	result, _ := nb.runner.RunBenchmark("network_latency", func(ctx context.Context) error {
		size := sizes[int(pingSent.Load())%len(sizes)]
		
		// Simulate ping-pong
		start := time.Now()
		simulatePingPong(size)
		latency := time.Since(start)
		
		pingSent.Add(1)
		totalLatency.Add(int64(latency))
		
		return nil
	})
	
	avgLatency := time.Duration(totalLatency.Load() / int64(pingSent.Load()))
	
	return &NetworkLatencyBenchmark{
		AvgLatency: avgLatency,
		P50Latency: result.P50Latency,
		P95Latency: result.P95Latency,
		P99Latency: result.P99Latency,
		Result:     result,
	}
}

// benchmarkDDoSProtection tests DDoS protection performance
func (nb *NetworkBenchmarks) benchmarkDDoSProtection() *DDoSProtectionBenchmark {
	nb.logger.Info("Benchmarking DDoS protection")
	
	var requestsProcessed atomic.Uint64
	var requestsBlocked atomic.Uint64
	
	// Create rate limiter
	rateLimiter := p2p.NewRateLimiter(nb.logger, 1000) // 1000 req/s limit
	
	result, _ := nb.runner.RunBenchmark("ddos_protection", func(ctx context.Context) error {
		// Simulate requests from different IPs
		ip := generateRandomIP()
		
		if rateLimiter.Allow(ip) {
			requestsProcessed.Add(1)
		} else {
			requestsBlocked.Add(1)
		}
		
		return nil
	})
	
	totalRequests := requestsProcessed.Load() + requestsBlocked.Load()
	
	return &DDoSProtectionBenchmark{
		RequestsPerSecond: float64(totalRequests) / result.Duration.Seconds(),
		BlockRatio:        float64(requestsBlocked.Load()) / float64(totalRequests),
		ProcessingLatency: result.AvgLatency,
		Result:            result,
	}
}

// Report structures

type NetworkBenchmarkReport struct {
	Timestamp         time.Time
	MessageThroughput *MessageThroughputBenchmark
	ConnectionPool    *ConnectionPoolBenchmark
	P2PBroadcast      *P2PBroadcastBenchmark
	NetworkLatency    *NetworkLatencyBenchmark
	DDoSProtection    *DDoSProtectionBenchmark
}

type MessageThroughputBenchmark struct {
	MessagesPerSecond float64
	BytesPerSecond    float64
	AvgMessageSize    float64
	Result            *BenchmarkResult
}

type ConnectionPoolBenchmark struct {
	ConnectionsPerSecond float64
	ReuseRatio          float64
	AvgGetLatency       time.Duration
	Result              *BenchmarkResult
}

type P2PBroadcastBenchmark struct {
	BroadcastsPerSecond float64
	AvgPeersReached     float64
	BroadcastLatency    time.Duration
	Result              *BenchmarkResult
}

type NetworkLatencyBenchmark struct {
	AvgLatency time.Duration
	P50Latency time.Duration
	P95Latency time.Duration
	P99Latency time.Duration
	Result     *BenchmarkResult
}

type DDoSProtectionBenchmark struct {
	RequestsPerSecond float64
	BlockRatio        float64
	ProcessingLatency time.Duration
	Result            *BenchmarkResult
}

// Helper functions

func processMessage(data []byte) {
	// Simulate message processing
	time.Sleep(time.Nanosecond * time.Duration(len(data)))
}

func simulateBroadcast(msg p2p.Message, peerCount int) int {
	// Simulate broadcast propagation
	// In reality, some peers might be offline
	reached := peerCount * 95 / 100 // 95% success rate
	time.Sleep(time.Microsecond * time.Duration(peerCount))
	return reached
}

func simulatePingPong(size int) {
	// Simulate network round trip
	baseLatency := 5 * time.Millisecond
	sizeLatency := time.Duration(size) * time.Nanosecond
	time.Sleep(baseLatency + sizeLatency)
}

func generateRandomIP() string {
	bytes := make([]byte, 4)
	rand.Read(bytes)
	return string(bytes)
}

// OptimizeNetwork provides network optimization suggestions
func (nb *NetworkBenchmarks) OptimizeNetwork(report *NetworkBenchmarkReport) []string {
	suggestions := []string{}
	
	// Message throughput optimization
	if report.MessageThroughput.MessagesPerSecond < 10000 {
		suggestions = append(suggestions, "Low message throughput. Consider batch processing.")
	}
	
	// Connection pool optimization
	if report.ConnectionPool.ReuseRatio < 0.8 {
		suggestions = append(suggestions, "Low connection reuse. Increase pool min size.")
	}
	
	// P2P optimization
	if report.P2PBroadcast.BroadcastLatency > 100*time.Millisecond {
		suggestions = append(suggestions, "High broadcast latency. Consider hierarchical broadcast.")
	}
	
	// Latency optimization
	if report.NetworkLatency.P99Latency > 10*report.NetworkLatency.P50Latency {
		suggestions = append(suggestions, "High latency variance. Check for network congestion.")
	}
	
	// DDoS protection
	if report.DDoSProtection.BlockRatio > 0.5 {
		suggestions = append(suggestions, "High block ratio. Review rate limiting thresholds.")
	}
	
	return suggestions
}