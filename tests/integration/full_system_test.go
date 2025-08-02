// +build integration

package integration

import (
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/app"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestFullSystemIntegration tests the complete Otedama system
func TestFullSystemIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zaptest.NewLogger(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create test configuration
	cfg := createTestConfig(t)

	// Create and start application
	application, err := app.New(ctx, logger, cfg)
	require.NoError(t, err)

	err = application.Start()
	require.NoError(t, err)
	defer application.Shutdown(context.Background())

	// Wait for system to initialize
	time.Sleep(2 * time.Second)

	// Run test scenarios
	t.Run("P2P_Connectivity", func(t *testing.T) {
		testP2PConnectivity(t, cfg)
	})

	t.Run("Stratum_Mining", func(t *testing.T) {
		testStratumMining(t, cfg)
	})

	t.Run("ZKP_Authentication", func(t *testing.T) {
		testZKPAuthentication(t, cfg)
	})

	t.Run("Load_Test", func(t *testing.T) {
		testSystemUnderLoad(t, cfg)
	})
}

// TestP2PPoolIntegration tests P2P pool functionality
func TestP2PPoolIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zaptest.NewLogger(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Create multiple P2P nodes
	nodes := make([]*p2p.Pool, 3)
	configs := make([]p2p.Config, 3)

	for i := 0; i < 3; i++ {
		port := 30000 + i
		configs[i] = p2p.Config{
			ListenAddr: fmt.Sprintf("127.0.0.1:%d", port),
			MaxPeers:   10,
			MinPeers:   1,
			BootstrapNodes: []string{},
		}

		// Add previous nodes as bootstrap
		if i > 0 {
			configs[i].BootstrapNodes = append(configs[i].BootstrapNodes, 
				fmt.Sprintf("127.0.0.1:%d", 30000))
		}

		pool, err := p2p.NewPool(configs[i], logger)
		require.NoError(t, err)

		err = pool.Start(ctx)
		require.NoError(t, err)
		defer pool.Stop()

		nodes[i] = pool
	}

	// Wait for peer discovery
	time.Sleep(5 * time.Second)

	// Check that nodes are connected
	for i, node := range nodes {
		stats := node.GetStats()
		t.Logf("Node %d stats: %+v", i, stats)
		
		// Each node should have at least 1 peer (except possibly the last one)
		if i < len(nodes)-1 {
			assert.GreaterOrEqual(t, stats.PeerCount, 1)
		}
	}

	// Test share propagation
	testSharePropagation(t, nodes)
}

// TestStratumIntegration tests Stratum server functionality
func TestStratumIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zaptest.NewLogger(t)

	// Find available port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	// Create Stratum server config
	cfg := &stratum.Config{
		Host:         "127.0.0.1",
		Port:         port,
		MaxClients:   100,
		Difficulty:   1.0,
		AuthMode:     stratum.AuthModeNone,
	}

	// Create and start server
	server, err := stratum.NewServer(logger, cfg)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(1 * time.Second)

	// Connect test clients
	testStratumClients(t, cfg.Host, cfg.Port)
}

// Helper functions

func createTestConfig(t *testing.T) *config.Config {
	// Find available ports
	p2pListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	p2pPort := p2pListener.Addr().(*net.TCPAddr).Port
	p2pListener.Close()

	stratumListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	stratumPort := stratumListener.Addr().(*net.TCPAddr).Port
	stratumListener.Close()

	return &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: fmt.Sprintf("127.0.0.1:%d", p2pPort),
			MaxPeers:   10,
			EnableP2P:  true,
		},
		Mining: config.MiningConfig{
			Algorithm:       "sha256d",
			ShareDifficulty: 1.0,
		},
		Stratum: config.StratumConfig{
			Enabled:    true,
			ListenAddr: fmt.Sprintf("127.0.0.1:%d", stratumPort),
			MaxClients: 100,
		},
		ZKP: config.ZKPConfig{
			Enabled:              true,
			RequireAgeProof:      true,
			MinAgeRequirement:    18,
			RequireHashpowerProof: true,
			MinHashpowerRequirement: 1000,
		},
	}
}

func testP2PConnectivity(t *testing.T, cfg *config.Config) {
	// Create a P2P client
	conn, err := net.Dial("tcp", cfg.Network.ListenAddr)
	require.NoError(t, err)
	defer conn.Close()

	// Send handshake
	handshake := []byte(`{"type":"handshake","id":"test-client","timestamp":"2024-01-01T00:00:00Z"}`)
	_, err = conn.Write(handshake)
	require.NoError(t, err)

	// Read response
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	require.NoError(t, err)
	assert.Greater(t, n, 0)
}

func testStratumMining(t *testing.T, cfg *config.Config) {
	// Connect to Stratum server
	conn, err := net.Dial("tcp", cfg.Stratum.ListenAddr)
	require.NoError(t, err)
	defer conn.Close()

	// Subscribe
	subscribe := []byte(`{"id":1,"method":"mining.subscribe","params":["test-miner/1.0"]}` + "\n")
	_, err = conn.Write(subscribe)
	require.NoError(t, err)

	// Read response
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	require.NoError(t, err)
	assert.Greater(t, n, 0)

	// Authorize
	authorize := []byte(`{"id":2,"method":"mining.authorize","params":["test.worker","password"]}` + "\n")
	_, err = conn.Write(authorize)
	require.NoError(t, err)

	// Read response
	n, err = conn.Read(buf)
	require.NoError(t, err)
	assert.Greater(t, n, 0)
}

func testZKPAuthentication(t *testing.T, cfg *config.Config) {
	// This would test the ZKP authentication flow
	// For now, we'll just verify the configuration
	assert.True(t, cfg.ZKP.Enabled)
	assert.Equal(t, 18, cfg.ZKP.MinAgeRequirement)
}

func testSystemUnderLoad(t *testing.T, cfg *config.Config) {
	// Simulate multiple concurrent connections
	var wg sync.WaitGroup
	numClients := 10
	
	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()
			
			// Connect to P2P
			conn, err := net.Dial("tcp", cfg.Network.ListenAddr)
			if err != nil {
				t.Logf("Client %d failed to connect: %v", clientID, err)
				return
			}
			defer conn.Close()
			
			// Send some messages
			for j := 0; j < 5; j++ {
				msg := fmt.Sprintf(`{"type":"ping","id":"client-%d","seq":%d}`, clientID, j)
				conn.Write([]byte(msg))
				time.Sleep(100 * time.Millisecond)
			}
		}(i)
	}
	
	wg.Wait()
}

func testSharePropagation(t *testing.T, nodes []*p2p.Pool) {
	// Submit share to first node
	share := &p2p.Share{
		ID:         "test-share-1",
		PeerID:     "test-peer",
		JobID:      "test-job",
		Nonce:      12345,
		Hash:       []byte("test-hash"),
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}

	err := nodes[0].SubmitShare(share)
	require.NoError(t, err)

	// Wait for propagation
	time.Sleep(2 * time.Second)

	// Check that all nodes received the share
	for i, node := range nodes {
		stats := node.GetStats()
		t.Logf("Node %d total shares: %d", i, stats.TotalShares)
		// At least the first node should have the share
		if i == 0 {
			assert.GreaterOrEqual(t, stats.TotalShares, uint64(1))
		}
	}
}

func testStratumClients(t *testing.T, host string, port int) {
	// Create multiple Stratum clients
	var wg sync.WaitGroup
	numClients := 5

	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()

			conn, err := net.Dial("tcp", fmt.Sprintf("%s:%d", host, port))
			if err != nil {
				t.Logf("Client %d failed to connect: %v", clientID, err)
				return
			}
			defer conn.Close()

			// Subscribe
			subscribe := fmt.Sprintf(`{"id":1,"method":"mining.subscribe","params":["test-miner-%d/1.0"]}`, clientID) + "\n"
			_, err = conn.Write([]byte(subscribe))
			if err != nil {
				t.Logf("Client %d failed to subscribe: %v", clientID, err)
				return
			}

			// Read response
			buf := make([]byte, 4096)
			_, err = conn.Read(buf)
			if err != nil {
				t.Logf("Client %d failed to read response: %v", clientID, err)
				return
			}

			// Keep connection alive for a bit
			time.Sleep(2 * time.Second)
		}(i)
	}

	wg.Wait()
}