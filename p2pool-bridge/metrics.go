// Metrics server and core client for P2Pool Bridge

package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/sirupsen/logrus"
)

// MetricsServer provides Prometheus metrics endpoint
type MetricsServer struct {
	config *Config
	server *http.Server
	
	// Prometheus metrics
	sharesTotal     prometheus.Counter
	blocksTotal     prometheus.Counter
	connectedPeers  prometheus.Gauge
	hashRate        prometheus.Gauge
	difficulty      prometheus.Gauge
	uptime          prometheus.Counter
}

// NewMetricsServer creates a new metrics server
func NewMetricsServer(cfg *Config) *MetricsServer {
	m := &MetricsServer{
		config: cfg,
		
		sharesTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "p2pool_shares_total",
			Help: "Total number of shares received",
		}),
		
		blocksTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "p2pool_blocks_total", 
			Help: "Total number of blocks found",
		}),
		
		connectedPeers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "p2pool_connected_peers",
			Help: "Number of connected peers",
		}),
		
		hashRate: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "p2pool_hash_rate",
			Help: "Current pool hash rate",
		}),
		
		difficulty: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "p2pool_difficulty",
			Help: "Current mining difficulty",
		}),
		
		uptime: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "p2pool_uptime_seconds_total",
			Help: "Total uptime in seconds",
		}),
	}
	
	// Register metrics
	prometheus.MustRegister(m.sharesTotal)
	prometheus.MustRegister(m.blocksTotal)
	prometheus.MustRegister(m.connectedPeers)
	prometheus.MustRegister(m.hashRate)
	prometheus.MustRegister(m.difficulty)
	prometheus.MustRegister(m.uptime)
	
	return m
}

// Start starts the metrics server
func (m *MetricsServer) Start(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	
	m.server = &http.Server{
		Addr:    fmt.Sprintf(":%d", m.config.Metrics.Port),
		Handler: mux,
	}
	
	log.WithField("port", m.config.Metrics.Port).Info("Starting metrics server")
	
	// Start metrics updater
	go m.updateMetrics(ctx)
	
	// Start server
	go func() {
		if err := m.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.WithError(err).Error("Metrics server failed")
		}
	}()
	
	// Wait for context cancellation
	<-ctx.Done()
	return m.shutdown()
}

// shutdown gracefully shuts down the metrics server
func (m *MetricsServer) shutdown() error {
	log.Info("Shutting down metrics server")
	
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return m.server.Shutdown(ctx)
}

// updateMetrics periodically updates metric values
func (m *MetricsServer) updateMetrics(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	startTime := time.Now()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Update uptime
			m.uptime.Add(10)
			
			// Mock data - in real implementation, get from core client
			m.connectedPeers.Set(5)
			m.hashRate.Set(1000000)
			m.difficulty.Set(1000.0)
			
			// Simulate occasional shares and blocks
			if time.Now().Unix()%5 == 0 {
				m.sharesTotal.Inc()
			}
			
			if time.Now().Unix()%300 == 0 { // Block every 5 minutes
				m.blocksTotal.Inc()
			}
		}
	}
}

// CoreClient manages communication with the Rust P2Pool core
type CoreClient struct {
	config  *Config
	cmd     *exec.Cmd
	mutex   sync.RWMutex
	running bool
}

// NewCoreClient creates a new core client
func NewCoreClient(cfg *Config) *CoreClient {
	return &CoreClient{
		config: cfg,
	}
}

// Start starts the core P2Pool process
func (c *CoreClient) Start(ctx context.Context) error {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	
	if c.running {
		return fmt.Errorf("core client already running")
	}
	
	log.Info("Starting P2Pool core process")
	
	// Build command arguments
	args := []string{
		"--config", c.config.Core.ConfigPath,
	}
	
	if c.config.API.Debug {
		args = append(args, "--debug")
	}
	
	// Create command
	c.cmd = exec.CommandContext(ctx, c.config.Core.ExecutablePath, args...)
	
	// Setup logging
	stdout, err := c.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	
	stderr, err := c.cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}
	
	// Start the process
	if err := c.cmd.Start(); err != nil {
		return fmt.Errorf("failed to start core process: %w", err)
	}
	
	c.running = true
	
	// Monitor stdout
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			log.WithField("source", "core-stdout").Info(scanner.Text())
		}
	}()
	
	// Monitor stderr
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.WithField("source", "core-stderr").Warn(scanner.Text())
		}
	}()
	
	// Wait for process to complete
	go func() {
		err := c.cmd.Wait()
		
		c.mutex.Lock()
		c.running = false
		c.mutex.Unlock()
		
		if err != nil {
			log.WithError(err).Error("Core process exited with error")
		} else {
			log.Info("Core process exited normally")
		}
	}()
	
	log.Info("P2Pool core process started")
	
	// Wait for context cancellation
	<-ctx.Done()
	return c.stop()
}

// stop stops the core process
func (c *CoreClient) stop() error {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	
	if !c.running || c.cmd == nil {
		return nil
	}
	
	log.Info("Stopping P2Pool core process")
	
	// Try graceful shutdown first
	if err := c.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		log.WithError(err).Warn("Failed to send SIGTERM, using SIGKILL")
		return c.cmd.Process.Kill()
	}
	
	// Wait for graceful shutdown with timeout
	done := make(chan error, 1)
	go func() {
		done <- c.cmd.Wait()
	}()
	
	select {
	case err := <-done:
		return err
	case <-time.After(10 * time.Second):
		log.Warn("Core process did not stop gracefully, killing")
		return c.cmd.Process.Kill()
	}
}

// IsRunning returns whether the core process is running
func (c *CoreClient) IsRunning() bool {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	return c.running
}

// GetStats returns current statistics from the core (mock implementation)
func (c *CoreClient) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"hash_rate":        1000000,
		"difficulty":       1000.0,
		"connected_peers":  5,
		"shares_per_second": 10,
		"blocks_found":     1,
		"uptime":           3600,
		"version":          "0.1.0",
	}
}

// SubmitShare submits a share to the core (mock implementation)
func (c *CoreClient) SubmitShare(share map[string]interface{}) error {
	log.WithField("share", share).Debug("Submitting share to core")
	// In real implementation, this would communicate with the Rust core
	return nil
}

// GetWork requests new work from the core (mock implementation)
func (c *CoreClient) GetWork() (map[string]interface{}, error) {
	work := map[string]interface{}{
		"job_id":    fmt.Sprintf("%08x", time.Now().Unix()),
		"prevhash":  "0000000000000000000000000000000000000000000000000000000000000000",
		"coinbase1": "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
		"coinbase2": "ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000",
		"merkle":    []string{},
		"version":   "00000001",
		"nbits":     "1d00ffff",
		"ntime":     fmt.Sprintf("%08x", time.Now().Unix()),
	}
	
	return work, nil
}
