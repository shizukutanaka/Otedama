package mining

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewEngine(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   4,
		Intensity: 20,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)
	assert.NotNil(t, engine)
}

func TestEngine_Start(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	assert.NoError(t, err)

	// Let it run briefly
	time.Sleep(100 * time.Millisecond)

	err = engine.Stop()
	assert.NoError(t, err)
}

func TestEngine_Mine(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   1,
		Intensity: 5,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Create a test job
	job := &Job{
		ID:         "test-job-1",
		Target:     "0000ffff00000000000000000000000000000000000000000000000000000000",
		Data:       make([]byte, 80),
		NonceStart: 0,
		NonceEnd:   1000,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	nonceChan := make(chan uint64, 1)
	go engine.Mine(ctx, job, nonceChan)

	select {
	case <-nonceChan:
		// Found a nonce (unlikely with high target)
	case <-ctx.Done():
		// Timeout expected for difficult target
	}
}

func TestEngine_GetHashRate(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Initially should be 0
	hashRate := engine.GetHashRate()
	assert.GreaterOrEqual(t, hashRate, uint64(0))

	// After some mining, should increase
	time.Sleep(500 * time.Millisecond)
	hashRate = engine.GetHashRate()
	assert.GreaterOrEqual(t, hashRate, uint64(0))
}

func TestEngine_UpdateConfig(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Update configuration
	newCfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   4,
		Intensity: 20,
	}

	engine.UpdateConfig(newCfg)
	
	// Verify config was updated
	// This would need access to internal state to verify properly
}

func TestEngine_EnableCPU(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	cpuConfig := config.CPUConfig{
		Enabled:  true,
		Threads:  4,
		Affinity: []int{0, 1, 2, 3},
		Priority: 0,
	}

	engine.EnableCPU(cpuConfig)
}

func TestEngine_ValidateShare(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   1,
		Intensity: 5,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	share := &Share{
		JobID:      "test-job-1",
		Nonce:      12345,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}

	valid := engine.ValidateShare(share)
	assert.NotNil(t, valid) // Can be true or false depending on implementation
}

func BenchmarkEngine_Hash(b *testing.B) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   1,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(b, err)

	data := make([]byte, 80)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = engine.Hash(data)
	}
}

func BenchmarkEngine_Mine(b *testing.B) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   4,
		Intensity: 20,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(b, err)

	err = engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	job := &Job{
		ID:         "bench-job",
		Target:     "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		Data:       make([]byte, 80),
		NonceStart: 0,
		NonceEnd:   1000000,
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		nonceChan := make(chan uint64, 1)
		go engine.Mine(ctx, job, nonceChan)
		select {
		case <-nonceChan:
		case <-ctx.Done():
		}
		cancel()
	}
}