package benchmark

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	v2 "github.com/shizukutanaka/Otedama/internal/stratum/v2"
	"go.uber.org/zap/zaptest"
)

// BenchmarkConnectionPool benchmarks connection pool operations
func BenchmarkConnectionPool(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	pool := p2p.NewOptimizedConnectionPool(logger, p2p.ConnectionPoolConfig{
		MinConnections: 10,
		MaxConnections: 100,
		MaxIdleTime:    30 * time.Second,
		DialTimeout:    5 * time.Second,
	})
	defer pool.Close()
	
	// Create test server
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			// Echo server
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1024)
				for {
					n, err := c.Read(buf)
					if err != nil {
						return
					}
					c.Write(buf[:n])
				}
			}(conn)
		}
	}()
	
	addr := listener.Addr().String()
	
	b.Run("Get", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				conn, err := pool.Get(addr, p2p.ConnTypeTCP)
				if err != nil {
					b.Fatal(err)
				}
				pool.Put(conn)
			}
		})
	})
	
	b.Run("GetPut", func(b *testing.B) {
		// Pre-warm pool
		for i := 0; i < 50; i++ {
			conn, _ := pool.Get(addr, p2p.ConnTypeTCP)
			pool.Put(conn)
		}
		
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				conn, err := pool.Get(addr, p2p.ConnTypeTCP)
				if err != nil {
					b.Fatal(err)
				}
				
				// Simulate work
				data := []byte("test")
				conn.Write(data)
				conn.Read(data)
				
				pool.Put(conn)
			}
		})
	})
	
	stats := pool.GetStats()
	b.ReportMetric(float64(stats.Hits)/float64(stats.TotalRequests)*100, "hit_rate_%")
}

// BenchmarkP2PPool benchmarks P2P pool operations
func BenchmarkP2PPool(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := p2p.Config{
		ListenAddr:      "127.0.0.1:0",
		MaxPeers:        100,
		ShareDifficulty: 1.0,
	}
	
	pool, err := p2p.NewPool(logger, config)
	if err != nil {
		b.Fatal(err)
	}
	
	pool.Start()
	defer pool.Stop()
	
	b.Run("ShareSubmission", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				share := &p2p.Share{
					ID:         string(rune(i)),
					PeerID:     "bench-peer",
					JobID:      "bench-job",
					Nonce:      uint64(i),
					Difficulty: 1.0,
					Timestamp:  time.Now(),
					Valid:      true,
				}
				
				pool.shares.Store(share.ID, share)
				pool.totalShares.Add(1)
				pool.validShares.Add(1)
				i++
			}
		})
	})
	
	b.Run("PeerManagement", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				if i%2 == 0 {
					// Add peer
					peer := &p2p.Peer{
						ID:      string(rune(i)),
						Address: "test",
					}
					pool.peers.Store(peer.ID, peer)
					pool.peerCount.Add(1)
				} else {
					// Remove peer
					pool.peers.Delete(string(rune(i - 1)))
					pool.peerCount.Add(-1)
				}
				i++
			}
		})
	})
}

// BenchmarkStratumV2Protocol benchmarks Stratum v2 protocol operations
func BenchmarkStratumV2Protocol(b *testing.B) {
	protocol := v2.NewProtocolHandler()
	
	b.Run("SerializeFrame", func(b *testing.B) {
		payload := make([]byte, 100)
		b.SetBytes(int64(len(payload)))
		b.ResetTimer()
		
		for i := 0; i < b.N; i++ {
			_, _ = protocol.SerializeFrame(v2.MsgNewMiningJob, payload)
		}
	})
	
	b.Run("DeserializeFrame", func(b *testing.B) {
		payload := make([]byte, 100)
		frame, _ := protocol.SerializeFrame(v2.MsgNewMiningJob, payload)
		b.SetBytes(int64(len(frame)))
		b.ResetTimer()
		
		for i := 0; i < b.N; i++ {
			_, _ = protocol.DeserializeFrame(frame)
		}
	})
	
	b.Run("RoundTrip", func(b *testing.B) {
		payload := make([]byte, 100)
		b.SetBytes(int64(len(payload)))
		b.ResetTimer()
		
		for i := 0; i < b.N; i++ {
			frame, _ := protocol.SerializeFrame(v2.MsgNewMiningJob, payload)
			_, _ = protocol.DeserializeFrame(frame)
		}
	})
}

// BenchmarkFailoverManager benchmarks pool failover operations
func BenchmarkFailoverManager(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	// Create mock pools
	pools := []pool.PoolConfig{
		{Name: "pool1", URL: "stratum+tcp://pool1.example.com:3333", Priority: 1},
		{Name: "pool2", URL: "stratum+tcp://pool2.example.com:3333", Priority: 2},
		{Name: "pool3", URL: "stratum+tcp://pool3.example.com:3333", Priority: 3},
	}
	
	fm, err := pool.NewFailoverManager(logger, pool.FailoverConfig{
		Pools:            pools,
		Strategy:         pool.StrategyPriority,
		RetryInterval:    30 * time.Second,
		ConnectTimeout:   5 * time.Second,
		EnableScoring:    true,
	})
	if err != nil {
		b.Fatal(err)
	}
	
	b.Run("PoolScoring", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			fm.calculatePoolScore(fm.pools[0])
		}
	})
	
	b.Run("GetPoolOrder", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = fm.getPoolOrder(0)
		}
	})
	
	b.Run("ShareSubmission", func(b *testing.B) {
		// Mock successful pool
		fm.pools[0].connected.Store(true)
		fm.pools[0].healthy.Store(true)
		fm.currentPool.Store(0)
		
		// Mock client
		fm.pools[0].client = &mockStratumClient{}
		
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				share := &stratum.Share{
					JobID: "bench-job",
					Nonce: uint64(i),
				}
				_ = fm.SubmitShare(share)
				i++
			}
		})
	})
}

// BenchmarkMessageQueue benchmarks P2P message queue
func BenchmarkMessageQueue(b *testing.B) {
	queue := p2p.NewMessageQueue(p2p.MessageQueueConfig{
		MaxSize:     10000,
		MaxPriority: 3,
	})
	defer queue.Close()
	
	b.Run("Enqueue", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				msg := &p2p.Message{
					ID:       string(rune(i)),
					Type:     p2p.MessageTypeShare,
					Priority: p2p.Priority(i % 3),
					Data:     []byte("test"),
				}
				_ = queue.Enqueue(msg)
				i++
			}
		})
	})
	
	b.Run("Dequeue", func(b *testing.B) {
		// Pre-fill queue
		for i := 0; i < 5000; i++ {
			msg := &p2p.Message{
				ID:       string(rune(i)),
				Type:     p2p.MessageTypeShare,
				Priority: p2p.Priority(i % 3),
			}
			queue.Enqueue(msg)
		}
		
		ctx := context.Background()
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				_, _ = queue.Dequeue(ctx)
			}
		})
	})
}

// BenchmarkRateLimiter benchmarks rate limiting
func BenchmarkRateLimiter(b *testing.B) {
	limiter := p2p.NewRateLimiter(1000, 2000) // 1000 req/s, burst 2000
	
	b.Run("Allow", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				_ = limiter.Allow()
			}
		})
	})
	
	b.Run("AllowN", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				_ = limiter.AllowN(10)
			}
		})
	})
}

// BenchmarkCircuitBreaker benchmarks circuit breaker
func BenchmarkCircuitBreaker(b *testing.B) {
	cb := p2p.NewCircuitBreaker(5, 1*time.Second)
	
	b.Run("RecordSuccess", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				cb.RecordSuccess()
			}
		})
	})
	
	b.Run("RecordFailure", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				cb.RecordFailure()
			}
		})
	})
	
	b.Run("Allow", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				_ = cb.Allow()
			}
		})
	})
}

// BenchmarkShareValidation benchmarks share validation
func BenchmarkShareValidation(b *testing.B) {
	validator := p2p.NewShareValidator(p2p.ShareValidatorConfig{
		MinDifficulty: 1.0,
		MaxDifficulty: 1000000.0,
	})
	
	share := &p2p.Share{
		ID:         "bench-share",
		JobID:      "bench-job",
		Nonce:      12345,
		Hash:       make([]byte, 32),
		Difficulty: 1000.0,
	}
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = validator.Validate(share)
		}
	})
}

// Mock stratum client for testing
type mockStratumClient struct{}

func (m *mockStratumClient) SubmitShare(share *stratum.Share) error {
	// Simulate some work
	time.Sleep(100 * time.Microsecond)
	return nil
}

func (m *mockStratumClient) Disconnect() {}

// BenchmarkNetworkThroughput simulates network throughput
func BenchmarkNetworkThroughput(b *testing.B) {
	// Create server
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	
	// Simple echo server
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handleEchoConnection(conn)
		}
	}()
	
	addr := listener.Addr().String()
	
	sizes := []int{64, 256, 1024, 4096}
	
	for _, size := range sizes {
		b.Run("Size="+string(rune(size)), func(b *testing.B) {
			conn, err := net.Dial("tcp", addr)
			if err != nil {
				b.Fatal(err)
			}
			defer conn.Close()
			
			data := make([]byte, size)
			buf := make([]byte, size)
			
			b.SetBytes(int64(size * 2)) // Round trip
			b.ResetTimer()
			
			for i := 0; i < b.N; i++ {
				if _, err := conn.Write(data); err != nil {
					b.Fatal(err)
				}
				if _, err := conn.Read(buf); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func handleEchoConnection(conn net.Conn) {
	defer conn.Close()
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return
		}
		if _, err := conn.Write(buf[:n]); err != nil {
			return
		}
	}
}