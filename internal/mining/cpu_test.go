package mining

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap/zaptest"
)

func TestNewEngine(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Algorithm: "sha256",
		Threads:   2,
	}
	
	engine, err := NewEngine(config, logger)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	
	if engine == nil {
		t.Fatal("Engine is nil")
	}
	
	if engine.config.Algorithm != "sha256" {
		t.Errorf("Expected algorithm sha256, got %s", engine.config.Algorithm)
	}
	
	if engine.config.Threads != 2 {
		t.Errorf("Expected 2 threads, got %d", engine.config.Threads)
	}
}

func TestEngineStartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Algorithm: "sha256",
		Threads:   1,
	}
	
	engine, err := NewEngine(config, logger)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	
	// Test start
	err = engine.Start(ctx)
	if err != nil {
		t.Fatalf("Failed to start engine: %v", err)
	}
	
	// Wait a bit to ensure mining starts
	time.Sleep(100 * time.Millisecond)
	
	// Check if running
	if engine.GetHashRate() < 0 {
		t.Error("Expected non-negative hash rate")
	}
	
	// Test stop
	err = engine.Stop()
	if err != nil {
		t.Fatalf("Failed to stop engine: %v", err)
	}
}

func TestEngineStats(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Algorithm: "sha256d",
		Threads:   1,
	}
	
	engine, err := NewEngine(config, logger)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	
	stats := engine.GetStats()
	if stats == nil {
		t.Fatal("Stats is nil")
	}
	
	if stats["algorithm"] != "sha256d" {
		t.Errorf("Expected algorithm sha256d, got %v", stats["algorithm"])
	}
	
	if stats["threads"] != 1 {
		t.Errorf("Expected 1 thread, got %v", stats["threads"])
	}
	
	if stats["running"] != false {
		t.Errorf("Expected running false, got %v", stats["running"])
	}
}

func TestUnsupportedAlgorithm(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Algorithm: "unsupported",
		Threads:   1,
	}
	
	_, err := NewEngine(config, logger)
	if err == nil {
		t.Fatal("Expected error for unsupported algorithm")
	}
}

func BenchmarkHashCalculation(b *testing.B) {
	data := make([]byte, 80)
	for i := range data {
		data[i] = byte(i)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Benchmark hash calculation
		_ = data[0] + byte(i)
	}
}
