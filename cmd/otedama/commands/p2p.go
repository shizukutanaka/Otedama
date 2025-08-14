package commands

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/shizukutanaka/Otedama/internal/app"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
)

// p2pCmd represents the p2p command
var p2pCmd = &cobra.Command{
	Use:   "p2p",
	Short: "P2P pool management",
	Long:  `Manage P2P mining pools - join existing pools or create new ones.`,
}

// p2pJoinCmd represents the p2p join command
var p2pJoinCmd = &cobra.Command{
	Use:   "join",
	Short: "Join existing P2P pool",
	Long: `Join an existing P2P mining pool.

Example:
  otedama p2p join --bootstrap 192.168.1.100:3333,192.168.1.101:3333`,
	RunE: runP2PJoin,
}

// p2pCreateCmd represents the p2p create command
var p2pCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create new P2P pool",
	Long: `Create a new P2P mining pool.

Example:
  otedama p2p create --name "MyPool" --fee 1.0 --min-payout 0.1`,
	RunE: runP2PCreate,
}

func init() {
	rootCmd.AddCommand(p2pCmd)
	p2pCmd.AddCommand(p2pJoinCmd)
	p2pCmd.AddCommand(p2pCreateCmd)
	
	// Join command flags
	p2pJoinCmd.Flags().String("config", "config.yaml", "Configuration file path")
	p2pJoinCmd.Flags().String("bootstrap", "", "Bootstrap nodes (comma-separated)")
	p2pJoinCmd.Flags().String("wallet", "", "Your wallet address")
	p2pJoinCmd.Flags().String("worker", "worker1", "Worker name")
	p2pJoinCmd.Flags().Int("port", 18555, "Local P2P port")
	p2pJoinCmd.Flags().String("algorithm", "", "Mining algorithm override (optional)")
	p2pJoinCmd.Flags().Int("threads", 0, "Number of CPU threads (0=auto)")
	p2pJoinCmd.MarkFlagRequired("bootstrap")
	p2pJoinCmd.MarkFlagRequired("wallet")
	
	// Create command flags
	p2pCreateCmd.Flags().String("config", "config.yaml", "Configuration file path")
	p2pCreateCmd.Flags().String("name", "", "Pool name (required)")
	p2pCreateCmd.Flags().Float64("fee", 1.0, "Pool fee percentage")
	p2pCreateCmd.Flags().Float64("min-payout", 0.1, "Minimum payout threshold")
	p2pCreateCmd.Flags().String("algorithm", "randomx", "Mining algorithm")
	p2pCreateCmd.Flags().Int("port", 18555, "P2P listening port")
	p2pCreateCmd.Flags().String("announce", "", "Public announce address (optional)")
	p2pCreateCmd.MarkFlagRequired("name")
}

func runP2PJoin(cmd *cobra.Command, args []string) error {
	// Read CLI flags
	configPath, _ := cmd.Flags().GetString("config")
	bootstrap, _ := cmd.Flags().GetString("bootstrap")
	wallet, _ := cmd.Flags().GetString("wallet")
	worker, _ := cmd.Flags().GetString("worker")
	port, _ := cmd.Flags().GetInt("port")
	algorithm, _ := cmd.Flags().GetString("algorithm")
	threads, _ := cmd.Flags().GetInt("threads")

	// Normalize bootstrap list
	rawNodes := strings.Split(bootstrap, ",")
	bootstrapNodes := make([]string, 0, len(rawNodes))
	for _, n := range rawNodes {
		s := strings.TrimSpace(n)
		if s != "" {
			bootstrapNodes = append(bootstrapNodes, s)
		}
	}

	// Load configuration via manager using a temporary no-op logger
	tempLogger := zap.NewNop()
	cfgManager, err := config.NewManager(tempLogger, configPath)
	if err != nil {
		return fmt.Errorf("failed to create config manager: %w", err)
	}
	cfg := cfgManager.Get()

	// Apply CLI overrides to config
	if algorithm != "" {
		cfg.Mining.Algorithm = algorithm
	}
	if threads > 0 {
		cfg.Mining.CPUThreads = threads
	}

	cfg.Network.P2P.Enabled = true
	cfg.Network.P2P.ListenAddr = fmt.Sprintf(":%d", port)
	// Keep both fields in sync for compatibility
	cfg.Network.P2P.BootstrapNodes = bootstrapNodes
	cfg.Network.P2P.BootstrapPeers = bootstrapNodes

	// When joining, do not run local stratum server
	cfg.Network.Stratum.Enabled = false

	// Disable local pool manager when joining an external P2P pool network
	cfg.Pool.Enabled = false
	cfg.Pool.URL = ""
	cfg.Pool.WalletAddress = wallet
	cfg.Pool.WorkerName = worker

	// Initialize logger
	logger, err := initializeLogger(cfg, false, "")
	if err != nil {
		return fmt.Errorf("failed to initialize logger: %w", err)
	}
	defer logger.Sync()

	// Create application context
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Create and start application
	logger.Info("Joining P2P network",
		zap.Strings("bootstrap", bootstrapNodes),
		zap.String("listen", cfg.Network.P2P.ListenAddr),
		zap.String("wallet", cfg.Pool.WalletAddress),
		zap.String("worker", cfg.Pool.WorkerName),
		zap.String("algorithm", cfg.Mining.Algorithm),
		zap.Int("threads", cfg.Mining.CPUThreads),
	)

	application, err := app.New(ctx, logger, cfg)
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}

	if err := application.Start(); err != nil {
		return fmt.Errorf("failed to start application: %w", err)
	}

	fmt.Println("P2P mining started. Press Ctrl+C to stop.")

	// Wait for shutdown signal
	select {
	case sig := <-sigChan:
		logger.Info("Received shutdown signal", zap.String("signal", sig.String()))
	case <-ctx.Done():
		logger.Info("Context cancelled")
	}

	// Graceful shutdown
	logger.Info("Starting graceful shutdown...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := application.Shutdown(shutdownCtx); err != nil {
		logger.Error("Failed to shutdown gracefully", zap.Error(err))
		return err
	}

	logger.Info("Stopped successfully")
	return nil
}

func runP2PCreate(cmd *cobra.Command, args []string) error {
	// Read CLI flags
	configPath, _ := cmd.Flags().GetString("config")
	name, _ := cmd.Flags().GetString("name")
	fee, _ := cmd.Flags().GetFloat64("fee")
	minPayout, _ := cmd.Flags().GetFloat64("min-payout")
	algorithm, _ := cmd.Flags().GetString("algorithm")
	port, _ := cmd.Flags().GetInt("port")
	announce, _ := cmd.Flags().GetString("announce")

	// Load configuration via manager using a temporary no-op logger
	tempLogger := zap.NewNop()
	cfgManager, err := config.NewManager(tempLogger, configPath)
	if err != nil {
		return fmt.Errorf("failed to create config manager: %w", err)
	}
	cfg := cfgManager.Get()

	// Apply CLI overrides
	cfg.Mining.Algorithm = algorithm
	cfg.Network.P2P.Enabled = true
	cfg.Network.P2P.ListenAddr = fmt.Sprintf(":%d", port)
	// For newly created pool, ensure Stratum server is enabled to accept miners
	cfg.Network.Stratum.Enabled = true
	// Enable pool manager (database will be initialized by app.New)
	cfg.Pool.Enabled = true
	// Best-effort propagation of pool economics (core may override with defaults)
	cfg.Pool.PoolFeePercent = fee
	cfg.Pool.FeePercentage = fee
	cfg.Pool.MinimumPayout = minPayout
	cfg.Pool.Address = name // store name in address field if applicable; no explicit name field exists

	// Initialize logger
	logger, err := initializeLogger(cfg, false, "")
	if err != nil {
		return fmt.Errorf("failed to initialize logger: %w", err)
	}
	defer logger.Sync()

	// Create application context
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Create and start application
	logger.Info("Creating P2P pool node",
		zap.String("name", name),
		zap.Float64("fee_percent", fee),
		zap.Float64("min_payout", minPayout),
		zap.String("algorithm", cfg.Mining.Algorithm),
		zap.String("p2p_listen", cfg.Network.P2P.ListenAddr),
		zap.String("announce", announce),
	)

	application, err := app.New(ctx, logger, cfg)
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}

	if err := application.Start(); err != nil {
		return fmt.Errorf("failed to start application: %w", err)
	}

	fmt.Println("P2P pool node started. Press Ctrl+C to stop.")

	// Wait for shutdown signal
	select {
	case sig := <-sigChan:
		logger.Info("Received shutdown signal", zap.String("signal", sig.String()))
	case <-ctx.Done():
		logger.Info("Context cancelled")
	}

	// Graceful shutdown
	logger.Info("Starting graceful shutdown...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := application.Shutdown(shutdownCtx); err != nil {
		logger.Error("Failed to shutdown gracefully", zap.Error(err))
		return err
	}

	logger.Info("Stopped successfully")
	return nil
}