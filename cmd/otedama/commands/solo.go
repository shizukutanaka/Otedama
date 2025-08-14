package commands

import (
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/yaml.v3"
)

var soloCmd = &cobra.Command{
	Use:   "solo",
	Short: "Start solo mining with optional P2P support",
	Long: `Start a solo mining operation that can work completely independently
or optionally join P2P networks for share distribution.

This mode is optimized for single miners who want:
- Complete control over their mining operation
- No dependency on mining pools
- Optional P2P networking for redundancy
- Local share tracking and statistics`,
	RunE: runSolo,
}

var (
	soloAlgorithm  string
	soloThreads    int
	soloConfigFile string
)

func init() {
	rootCmd.AddCommand(soloCmd)
	
	// Mining flags
	soloCmd.Flags().StringVarP(&soloAlgorithm, "algorithm", "a", "sha256d", "Mining algorithm")
	soloCmd.Flags().IntVarP(&soloThreads, "threads", "t", 0, "Number of mining threads (0=auto)")
	
	// Config flag
	soloCmd.Flags().StringVarP(&soloConfigFile, "config", "c", "", "Configuration file")
}

func runSolo(cmd *cobra.Command, args []string) error {
	// Create logger
	logConfig := zap.NewProductionConfig()
	logConfig.EncoderConfig.TimeKey = "timestamp"
	logConfig.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	
	logger, err := logConfig.Build()
	if err != nil {
		return fmt.Errorf("failed to create logger: %w", err)
	}
	defer logger.Sync()
	
	// Load or create configuration (only supported fields)
	var config mining.Config
	
	if soloConfigFile != "" {
		// Load from file
		data, err := os.ReadFile(soloConfigFile)
		if err != nil {
			return fmt.Errorf("failed to read config file: %w", err)
		}
		if err := yaml.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("failed to parse config: %w", err)
		}
	} else {
		// Use command line flags
		config = mining.Config{
			Algorithm:  soloAlgorithm,
			CPUThreads: soloThreads,
		}
		// Set defaults
		if config.CPUThreads == 0 {
			config.CPUThreads = runtime.NumCPU()
		}
	}
	
	// Note: wallet is not part of mining.Config; solo mode runs local engine only.
	
	logger.Info("Starting Otedama solo miner",
		zap.String("algorithm", config.Algorithm),
		zap.Int("threads", config.CPUThreads),
	)
	
	// Create engine
	engine, err := mining.NewEngine(logger, &config)
	if err != nil {
		return fmt.Errorf("failed to create engine: %w", err)
	}
	
	// Start mining
	if err := engine.Start(); err != nil {
		return fmt.Errorf("failed to start engine: %w", err)
	}
	
	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	// Print initial stats
	printSoloStats(engine)
	
	// Start stats ticker
	statsTicker := time.NewTicker(30 * time.Second)
	defer statsTicker.Stop()
	
	// Wait for shutdown
	for {
		select {
		case <-sigChan:
			logger.Info("Shutdown signal received")
			if err := engine.Stop(); err != nil {
				logger.Error("Failed to stop miner", zap.Error(err))
			}
			return nil
			
		case <-statsTicker.C:
			printSoloStats(engine)
		}
	}
}

func printSoloStats(engine mining.Engine) {
	stats := engine.GetStats()
	fmt.Println("\n=== Otedama Solo Mining Statistics ===")
	fmt.Printf("Algorithm:     %s\n", engine.GetAlgorithm())
	fmt.Printf("CPU Threads:   %d\n", engine.GetCPUThreads())
	fmt.Printf("Total Rate:    %d H/s\n", stats.TotalHashRate)
	fmt.Printf("Current Rate:  %d H/s\n", stats.CurrentHashRate)
	fmt.Printf("Shares:        submitted=%d accepted=%d rejected=%d\n", stats.SharesSubmitted, stats.SharesAccepted, stats.SharesRejected)
	fmt.Printf("Blocks Found:  %d\n", stats.BlocksFound)
	fmt.Printf("Uptime:        %s\n", stats.Uptime.String())
	fmt.Println("=====================================")
}