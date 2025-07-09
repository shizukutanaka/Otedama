// P2Pool Bridge Service
//
// Go-based API bridge for P2Pool core (Rust)
// Following Rob Pike's Go philosophy: simple, practical, concurrent

package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var (
	log    = logrus.New()
	config *Config
)

// Config represents bridge service configuration
type Config struct {
	API struct {
		Port     int    `mapstructure:"port"`
		Host     string `mapstructure:"host"`
		Debug    bool   `mapstructure:"debug"`
		CorsMode string `mapstructure:"cors_mode"`
	} `mapstructure:"api"`
	
	Stratum struct {
		Port            int    `mapstructure:"port"`
		Host            string `mapstructure:"host"`
		PoolAddress     string `mapstructure:"pool_address"`
		ExtraNonce1Size int    `mapstructure:"extranonce1_size"`
	} `mapstructure:"stratum"`
	
	Core struct {
		ExecutablePath string `mapstructure:"executable_path"`
		ConfigPath     string `mapstructure:"config_path"`
		DataDir        string `mapstructure:"data_dir"`
	} `mapstructure:"core"`
	
	Metrics struct {
		Enabled bool `mapstructure:"enabled"`
		Port    int  `mapstructure:"port"`
	} `mapstructure:"metrics"`
}

// defaultConfig returns default configuration
func defaultConfig() *Config {
	return &Config{
		API: struct {
			Port     int    `mapstructure:"port"`
			Host     string `mapstructure:"host"`
			Debug    bool   `mapstructure:"debug"`
			CorsMode string `mapstructure:"cors_mode"`
		}{
			Port:     8080,
			Host:     "0.0.0.0",
			Debug:    false,
			CorsMode: "release",
		},
		Stratum: struct {
			Port            int    `mapstructure:"port"`
			Host            string `mapstructure:"host"`
			PoolAddress     string `mapstructure:"pool_address"`
			ExtraNonce1Size int    `mapstructure:"extranonce1_size"`
		}{
			Port:            3333,
			Host:            "0.0.0.0",
			PoolAddress:     "",
			ExtraNonce1Size: 4,
		},
		Core: struct {
			ExecutablePath string `mapstructure:"executable_path"`
			ConfigPath     string `mapstructure:"config_path"`
			DataDir        string `mapstructure:"data_dir"`
		}{
			ExecutablePath: "./p2pool",
			ConfigPath:     "./config.json",
			DataDir:        "./data",
		},
		Metrics: struct {
			Enabled bool `mapstructure:"enabled"`
			Port    int  `mapstructure:"port"`
		}{
			Enabled: true,
			Port:    9090,
		},
	}
}

// Bridge manages the connection between Go services and Rust core
type Bridge struct {
	config       *Config
	apiServer    *APIServer
	stratumServer *StratumServer
	metricsServer *MetricsServer
	coreClient   *CoreClient
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// NewBridge creates a new bridge instance
func NewBridge(cfg *Config) *Bridge {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &Bridge{
		config:       cfg,
		apiServer:    NewAPIServer(cfg),
		stratumServer: NewStratumServer(cfg),
		metricsServer: NewMetricsServer(cfg),
		coreClient:   NewCoreClient(cfg),
		ctx:          ctx,
		cancel:       cancel,
	}
}

// Start starts all bridge services
func (b *Bridge) Start() error {
	log.Info("Starting P2Pool Bridge services...")
	
	// Start core client connection
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		if err := b.coreClient.Start(b.ctx); err != nil {
			log.WithError(err).Error("Core client failed")
		}
	}()
	
	// Start API server
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		if err := b.apiServer.Start(b.ctx); err != nil {
			log.WithError(err).Error("API server failed")
		}
	}()
	
	// Start Stratum server
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		if err := b.stratumServer.Start(b.ctx); err != nil {
			log.WithError(err).Error("Stratum server failed")
		}
	}()
	
	// Start metrics server if enabled
	if b.config.Metrics.Enabled {
		b.wg.Add(1)
		go func() {
			defer b.wg.Done()
			if err := b.metricsServer.Start(b.ctx); err != nil {
				log.WithError(err).Error("Metrics server failed")
			}
		}()
	}
	
	log.Info("All services started successfully")
	return nil
}

// Stop gracefully shuts down all services
func (b *Bridge) Stop() error {
	log.Info("Shutting down P2Pool Bridge...")
	
	b.cancel()
	
	// Wait for all goroutines to finish
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	
	// Wait for graceful shutdown or timeout
	select {
	case <-done:
		log.Info("All services stopped gracefully")
	case <-time.After(30 * time.Second):
		log.Warn("Forced shutdown after timeout")
	}
	
	return nil
}

// loadConfig loads configuration from file and environment
func loadConfig(configFile string) (*Config, error) {
	// Set defaults
	cfg := defaultConfig()
	
	// Set up viper
	viper.SetConfigFile(configFile)
	viper.SetConfigType("yaml")
	viper.AutomaticEnv()
	viper.SetEnvPrefix("P2POOL")
	
	// Try to read config file
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok {
			log.Warn("Config file not found, using defaults")
		} else {
			return nil, fmt.Errorf("error reading config file: %w", err)
		}
	}
	
	// Unmarshal config
	if err := viper.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("error unmarshaling config: %w", err)
	}
	
	return cfg, nil
}

// setupLogging configures the logger
func setupLogging(debug bool) {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
		TimestampFormat: "2006-01-02 15:04:05",
	})
	
	if debug {
		log.SetLevel(logrus.DebugLevel)
	} else {
		log.SetLevel(logrus.InfoLevel)
	}
}

// Root command
var rootCmd = &cobra.Command{
	Use:   "p2pool-bridge",
	Short: "P2Pool Bridge Service",
	Long: `P2Pool Bridge provides API, Stratum, and Web interfaces 
for the P2Pool distributed mining pool core.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Load configuration
		configFile, _ := cmd.Flags().GetString("config")
		cfg, err := loadConfig(configFile)
		if err != nil {
			log.WithError(err).Fatal("Failed to load configuration")
		}
		
		// Override with command line flags
		if port, _ := cmd.Flags().GetInt("api-port"); port != 0 {
			cfg.API.Port = port
		}
		if port, _ := cmd.Flags().GetInt("stratum-port"); port != 0 {
			cfg.Stratum.Port = port
		}
		if debug, _ := cmd.Flags().GetBool("debug"); debug {
			cfg.API.Debug = true
		}
		
		config = cfg
		setupLogging(cfg.API.Debug)
		
		log.WithFields(logrus.Fields{
			"api_port":     cfg.API.Port,
			"stratum_port": cfg.Stratum.Port,
			"metrics_port": cfg.Metrics.Port,
		}).Info("Starting P2Pool Bridge")
		
		// Create and start bridge
		bridge := NewBridge(cfg)
		
		// Setup signal handling
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		
		// Start bridge services
		if err := bridge.Start(); err != nil {
			log.WithError(err).Fatal("Failed to start bridge services")
		}
		
		// Wait for shutdown signal
		sig := <-sigChan
		log.WithField("signal", sig).Info("Received shutdown signal")
		
		// Graceful shutdown
		if err := bridge.Stop(); err != nil {
			log.WithError(err).Error("Error during shutdown")
		}
	},
}

func init() {
	rootCmd.Flags().StringP("config", "c", "config.yaml", "Configuration file path")
	rootCmd.Flags().IntP("api-port", "a", 0, "API server port")
	rootCmd.Flags().IntP("stratum-port", "s", 0, "Stratum server port")
	rootCmd.Flags().BoolP("debug", "d", false, "Enable debug logging")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		log.WithError(err).Fatal("Command execution failed")
		os.Exit(1)
	}
}
