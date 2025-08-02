package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/viper"
	"go.uber.org/zap"

	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/stratum"
)

// SimplePoolServer runs a simple mining pool like zpool
type SimplePoolServer struct {
	logger         *zap.Logger
	pool           *pool.SimplePool
	stratumServers []*stratum.SimpleStratumServer
}

// NewSimplePoolServer creates a new simple pool server
func NewSimplePoolServer() (*SimplePoolServer, error) {
	// Create logger
	logger, err := zap.NewProduction()
	if err != nil {
		return nil, err
	}

	// Load configuration
	viper.SetConfigName("config.simple")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.AddConfigPath("/etc/otedama")

	if err := viper.ReadInConfig(); err != nil {
		logger.Warn("No config file found, using defaults")
	}

	// Create pool
	poolConfig := pool.Config{
		MinPayout:      viper.GetFloat64("pool.min_payout"),
		PayoutInterval: viper.GetDuration("pool.payout_interval"),
		PoolFee:        viper.GetFloat64("pool.fee"),
	}

	simplePool := pool.NewSimplePool(logger, poolConfig)

	// Create stratum servers
	var stratumServers []*stratum.SimpleStratumServer
	
	var servers []struct {
		Algorithm  string  `mapstructure:"algorithm"`
		Port       int     `mapstructure:"port"`
		Difficulty float64 `mapstructure:"difficulty"`
	}
	
	if err := viper.UnmarshalKey("stratum.servers", &servers); err != nil {
		return nil, fmt.Errorf("failed to parse stratum config: %w", err)
	}

	for _, srv := range servers {
		config := stratum.SimpleConfig{
			Port:       srv.Port,
			Difficulty: srv.Difficulty,
			Algorithm:  srv.Algorithm,
		}
		
		stratumServer := stratum.NewSimpleStratumServer(logger, config)
		stratumServers = append(stratumServers, stratumServer)
	}

	return &SimplePoolServer{
		logger:         logger,
		pool:           simplePool,
		stratumServers: stratumServers,
	}, nil
}

// Start begins pool operations
func (s *SimplePoolServer) Start() error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start pool
	if err := s.pool.Start(ctx); err != nil {
		return fmt.Errorf("failed to start pool: %w", err)
	}

	// Start stratum servers
	for _, srv := range s.stratumServers {
		if err := srv.Start(ctx); err != nil {
			return fmt.Errorf("failed to start stratum server: %w", err)
		}
	}

	s.logger.Info("Simple mining pool started successfully")

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	s.logger.Info("Shutting down...")
	cancel()

	return nil
}

// RunSimplePool starts the simple pool server
func RunSimplePool() {
	server, err := NewSimplePoolServer()
	if err != nil {
		log.Fatal("Failed to create server:", err)
	}

	if err := server.Start(); err != nil {
		log.Fatal("Server error:", err)
	}
}