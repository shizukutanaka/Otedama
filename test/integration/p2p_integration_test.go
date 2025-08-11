// +build integration

package integration

import (
	"fmt"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestP2PNetworkBootstrap(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create bootstrap node
	bootstrapConfig := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19333",
		MaxPeers:        10,
		ProtocolVersion: 1,
		NetworkMagic:    0x12345678,
	}
	
	bootstrapNode, err := p2p.NewNetwork(logger, bootstrapConfig)
	require.NoError(t, err)
	
	err = bootstrapNode.Start()
	require.NoError(t, err)
	defer bootstrapNode.Stop()
	
	// Wait for bootstrap node to be ready
	time.Sleep(100 * time.Millisecond)
	
	// Create peer nodes
	numPeers := 3
	peers := make([]*p2p.Network, numPeers)
	
	for i := 0; i < numPeers; i++ {
		peerConfig := &p2p.NetworkConfig{
			ListenAddr:      fmt.Sprintf("127.0.0.1:%d", 19334+i),
			MaxPeers:        10,
			BootstrapNodes:  []string{"127.0.0.1:19333"},
			ProtocolVersion: 1,
			NetworkMagic:    0x12345678,
		}
		
		peer, err := p2p.NewNetwork(logger, peerConfig)
		require.NoError(t, err)
		
		err = peer.Start()
		require.NoError(t, err)
		peers[i] = peer
		
		// Give time to connect
		time.Sleep(200 * time.Millisecond)
	}
	
	// Wait for network to stabilize
	time.Sleep(1 * time.Second)
	
	// Check that all nodes are connected
	bootstrapPeers := bootstrapNode.GetPeers()
	assert.GreaterOrEqual(t, len(bootstrapPeers), numPeers)
	
	for i, peer := range peers {
		peerList := peer.GetPeers()
		assert.Greater(t, len(peerList), 0, "Peer %d should have connections", i)
	}
	
	// Cleanup
	for _, peer := range peers {
		err = peer.Stop()
		assert.NoError(t, err)
	}
}

func TestP2PMessageBroadcast(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create network of 3 nodes
	nodes := make([]*p2p.Network, 3)
	basePort := 19340
	
	for i := 0; i < 3; i++ {
		config := &p2p.NetworkConfig{
			ListenAddr:      fmt.Sprintf("127.0.0.1:%d", basePort+i),
			MaxPeers:        10,
			ProtocolVersion: 1,
			NetworkMagic:    0x12345678,
		}
		
		if i > 0 {
			// Connect to previous nodes
			config.BootstrapNodes = []string{fmt.Sprintf("127.0.0.1:%d", basePort)}
		}
		
		node, err := p2p.NewNetwork(logger, config)
		require.NoError(t, err)
		
		err = node.Start()
		require.NoError(t, err)
		nodes[i] = node
		
		time.Sleep(200 * time.Millisecond)
	}
	
	// Wait for network to form
	time.Sleep(1 * time.Second)
	
	// Broadcast message from first node
	testMessage := &p2p.Message{
		Type:    p2p.MessageTypeBlock,
		Payload: []byte("test block data"),
	}
	
	err := nodes[0].Broadcast(testMessage)
	assert.NoError(t, err)
	
	// Wait for propagation
	time.Sleep(500 * time.Millisecond)
	
	// Check that message was received by other nodes
	// This would require implementing message tracking in the network
	
	// Cleanup
	for _, node := range nodes {
		err = node.Stop()
		assert.NoError(t, err)
	}
}

func TestP2PNodeDiscovery(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create initial network
	basePort := 19350
	initialNodes := 2
	nodes := make([]*p2p.Network, 0)
	
	// Start initial nodes
	for i := 0; i < initialNodes; i++ {
		config := &p2p.NetworkConfig{
			ListenAddr:      fmt.Sprintf("127.0.0.1:%d", basePort+i),
			MaxPeers:        10,
			ProtocolVersion: 1,
			NetworkMagic:    0x12345678,
		}
		
		if i > 0 {
			config.BootstrapNodes = []string{fmt.Sprintf("127.0.0.1:%d", basePort)}
		}
		
		node, err := p2p.NewNetwork(logger, config)
		require.NoError(t, err)
		
		err = node.Start()
		require.NoError(t, err)
		nodes = append(nodes, node)
		
		time.Sleep(200 * time.Millisecond)
	}
	
	// Wait for initial network
	time.Sleep(500 * time.Millisecond)
	
	// Add new nodes dynamically
	newNodes := 3
	for i := 0; i < newNodes; i++ {
		config := &p2p.NetworkConfig{
			ListenAddr:      fmt.Sprintf("127.0.0.1:%d", basePort+initialNodes+i),
			MaxPeers:        10,
			BootstrapNodes:  []string{fmt.Sprintf("127.0.0.1:%d", basePort)},
			ProtocolVersion: 1,
			NetworkMagic:    0x12345678,
		}
		
		node, err := p2p.NewNetwork(logger, config)
		require.NoError(t, err)
		
		err = node.Start()
		require.NoError(t, err)
		nodes = append(nodes, node)
		
		time.Sleep(200 * time.Millisecond)
	}
	
	// Wait for discovery
	time.Sleep(2 * time.Second)
	
	// Check that new nodes discovered each other
	for i, node := range nodes {
		peers := node.GetPeers()
		t.Logf("Node %d has %d peers", i, len(peers))
		assert.Greater(t, len(peers), 0)
	}
	
	// Cleanup
	for _, node := range nodes {
		err := node.Stop()
		assert.NoError(t, err)
	}
}

func TestP2PReconnection(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create two nodes
	config1 := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19360",
		MaxPeers:        10,
		ProtocolVersion: 1,
		NetworkMagic:    0x12345678,
	}
	
	node1, err := p2p.NewNetwork(logger, config1)
	require.NoError(t, err)
	
	err = node1.Start()
	require.NoError(t, err)
	defer node1.Stop()
	
	config2 := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19361",
		MaxPeers:        10,
		BootstrapNodes:  []string{"127.0.0.1:19360"},
		ProtocolVersion: 1,
		NetworkMagic:    0x12345678,
	}
	
	node2, err := p2p.NewNetwork(logger, config2)
	require.NoError(t, err)
	
	err = node2.Start()
	require.NoError(t, err)
	
	// Wait for connection
	time.Sleep(500 * time.Millisecond)
	
	// Check connection
	peers1 := node1.GetPeers()
	assert.Equal(t, 1, len(peers1))
	
	peers2 := node2.GetPeers()
	assert.Equal(t, 1, len(peers2))
	
	// Stop node2
	err = node2.Stop()
	assert.NoError(t, err)
	
	// Wait for disconnection
	time.Sleep(1 * time.Second)
	
	// Check that node1 detected disconnection
	peers1 = node1.GetPeers()
	assert.Equal(t, 0, len(peers1))
	
	// Restart node2
	node2, err = p2p.NewNetwork(logger, config2)
	require.NoError(t, err)
	
	err = node2.Start()
	require.NoError(t, err)
	defer node2.Stop()
	
	// Wait for reconnection
	time.Sleep(1 * time.Second)
	
	// Check reconnection
	peers1 = node1.GetPeers()
	assert.Equal(t, 1, len(peers1))
	
	peers2 = node2.GetPeers()
	assert.Equal(t, 1, len(peers2))
}

func TestP2PMaxPeersLimit(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create bootstrap node with max 2 peers
	bootstrapConfig := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19370",
		MaxPeers:        2,
		ProtocolVersion: 1,
		NetworkMagic:    0x12345678,
	}
	
	bootstrapNode, err := p2p.NewNetwork(logger, bootstrapConfig)
	require.NoError(t, err)
	
	err = bootstrapNode.Start()
	require.NoError(t, err)
	defer bootstrapNode.Stop()
	
	// Try to connect 5 peers
	peers := make([]*p2p.Network, 5)
	for i := 0; i < 5; i++ {
		config := &p2p.NetworkConfig{
			ListenAddr:      fmt.Sprintf("127.0.0.1:%d", 19371+i),
			MaxPeers:        10,
			BootstrapNodes:  []string{"127.0.0.1:19370"},
			ProtocolVersion: 1,
			NetworkMagic:    0x12345678,
		}
		
		peer, err := p2p.NewNetwork(logger, config)
		require.NoError(t, err)
		
		err = peer.Start()
		require.NoError(t, err)
		peers[i] = peer
		
		time.Sleep(200 * time.Millisecond)
	}
	
	// Wait for connections
	time.Sleep(1 * time.Second)
	
	// Check that bootstrap node only has 2 peers
	bootstrapPeers := bootstrapNode.GetPeers()
	assert.LessOrEqual(t, len(bootstrapPeers), 2)
	
	// Check that some peers couldn't connect
	connectedCount := 0
	for _, peer := range peers {
		if len(peer.GetPeers()) > 0 {
			connectedCount++
		}
	}
	assert.LessOrEqual(t, connectedCount, 2)
	
	// Cleanup
	for _, peer := range peers {
		err = peer.Stop()
		assert.NoError(t, err)
	}
}

func TestP2PMessageValidation(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create two nodes with different network magic
	config1 := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19380",
		MaxPeers:        10,
		ProtocolVersion: 1,
		NetworkMagic:    0x12345678,
	}
	
	node1, err := p2p.NewNetwork(logger, config1)
	require.NoError(t, err)
	
	err = node1.Start()
	require.NoError(t, err)
	defer node1.Stop()
	
	// Node with different network magic (should not connect)
	config2 := &p2p.NetworkConfig{
		ListenAddr:      "127.0.0.1:19381",
		MaxPeers:        10,
		BootstrapNodes:  []string{"127.0.0.1:19380"},
		ProtocolVersion: 1,
		NetworkMagic:    0x87654321, // Different magic
	}
	
	node2, err := p2p.NewNetwork(logger, config2)
	require.NoError(t, err)
	
	err = node2.Start()
	require.NoError(t, err)
	defer node2.Stop()
	
	// Wait for connection attempt
	time.Sleep(1 * time.Second)
	
	// Check that nodes didn't connect due to different network magic
	peers1 := node1.GetPeers()
	assert.Equal(t, 0, len(peers1))
	
	peers2 := node2.GetPeers()
	assert.Equal(t, 0, len(peers2))
}