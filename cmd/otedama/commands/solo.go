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
	soloWallet     string
	soloAlgorithm  string
	soloThreads    int
	soloEnableP2P  bool
	soloP2PPort    int
	soloConfigFile string
)

func init() {
	rootCmd.AddCommand(soloCmd)
	
	// Mining flags
	soloCmd.Flags().StringVarP(&soloWallet, "wallet", "w", "", "Wallet address for mining rewards (required)")
	soloCmd.Flags().StringVarP(&soloAlgorithm, "algorithm", "a", "sha256d", "Mining algorithm")
	soloCmd.Flags().IntVarP(&soloThreads, "threads", "t", 0, "Number of mining threads (0=auto)")
	
	// P2P flags
	soloCmd.Flags().BoolVar(&soloEnableP2P, "p2p", false, "Enable P2P networking")
	soloCmd.Flags().IntVar(&soloP2PPort, "p2p-port", 18080, "P2P listening port")
	
	// Config flag
	soloCmd.Flags().StringVarP(&soloConfigFile, "config", "c", "", "Configuration file")
	
	// Mark wallet as required
	soloCmd.MarkFlagRequired("wallet")
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
	
	// Load or create configuration
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
			Wallet:      soloWallet,
			Algorithm:   soloAlgorithm,
			Threads:     soloThreads,
			EnableP2P:   soloEnableP2P,
			P2PPort:     soloP2PPort,
			LocalShares: true,
		}
		
		// Set defaults
		if config.Threads == 0 {
			config.Threads = runtime.NumCPU()
		}
	}
	
	// Validate configuration
	if config.Wallet == "" {
		return fmt.Errorf("wallet address is required")
	}
	
	logger.Info("Starting Otedama solo miner",
		zap.String("wallet", config.Wallet),
		zap.String("algorithm", config.Algorithm),
		zap.Int("threads", config.Threads),
		zap.Bool("p2p", config.EnableP2P),
	)
	
	// Create miner
	miner, err := mining.NewSoloHybridMiner(logger, config)
	if err != nil {
		return fmt.Errorf("failed to create miner: %w", err)
	}
	
	// Start mining
	if err := miner.Start(); err != nil {
		return fmt.Errorf("failed to start miner: %w", err)
	}
	
	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	// Print initial stats
	printSoloStats(miner)
	
	// Start stats ticker
	statsTicker := time.NewTicker(30 * time.Second)
	defer statsTicker.Stop()
	
	// Wait for shutdown
	for {
		select {
		case <-sigChan:
			logger.Info("Shutdown signal received")
			if err := miner.Stop(); err != nil {
				logger.Error("Failed to stop miner", zap.Error(err))
			}
			return nil
			
		case <-statsTicker.C:
			printSoloStats(miner)
		}
	}
}

func printSoloStats(miner *mining.SoloHybridMiner) {
	stats := miner.GetStats()
	
	fmt.Println("\n=== Otedama Solo Mining Statistics ===")
	fmt.Printf("Miner ID:    %s\n", stats["miner_id"])
	fmt.Printf("Algorithm:   %s\n", stats["algorithm"])
	fmt.Printf("Threads:     %d\n", stats["threads"])
	fmt.Printf("Hashrate:    %d H/s\n", stats["hashrate"])
	fmt.Printf("Difficulty:  %.2f\n", stats["difficulty"])
	fmt.Printf("Shares:      %d\n", stats["shares"])
	fmt.Printf("Blocks:      %d\n", stats["blocks"])
	fmt.Printf("Earnings:    %.8f\n", stats["earnings"])
	
	if p2pEnabled, ok := stats["p2p_enabled"].(bool); ok && p2pEnabled {
		fmt.Printf("\nP2P Status:  Enabled\n")
		fmt.Printf("Peers:       %d\n", stats["peer_count"])
	} else {
		fmt.Printf("\nP2P Status:  Disabled (Solo Mode)\n")
	}
	
	fmt.Println("=====================================")
}