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

// poolCmd represents the pool command
var poolCmd = &cobra.Command{
    Use:   "pool",
    Short: "Connect to traditional mining pools",
    Long: `Connect to traditional mining pools using Stratum protocol.

Example:
  otedama pool --url stratum+tcp://your-pool-address:3333 --wallet YOUR_WALLET --worker worker1`,
    RunE: runPool,
}

func init() {
    rootCmd.AddCommand(poolCmd)
    
    poolCmd.Flags().String("config", "config.yaml", "Configuration file path")
    poolCmd.Flags().String("url", "", "Pool URL (required)")
    poolCmd.Flags().String("wallet", "", "Wallet address (required)")
    poolCmd.Flags().String("worker", "worker1", "Worker name")
    poolCmd.Flags().String("password", "x", "Worker password")
    poolCmd.Flags().String("algorithm", "ethash", "Mining algorithm")
    poolCmd.Flags().Bool("ssl", false, "Use SSL/TLS connection")
    poolCmd.Flags().Int("threads", 0, "Number of CPU threads (0=auto)")
    
    poolCmd.MarkFlagRequired("url")
    poolCmd.MarkFlagRequired("wallet")
}

func runPool(cmd *cobra.Command, args []string) error {
    // Read CLI flags
    configPath, _ := cmd.Flags().GetString("config")
    url, _ := cmd.Flags().GetString("url")
    wallet, _ := cmd.Flags().GetString("wallet")
    worker, _ := cmd.Flags().GetString("worker")
    password, _ := cmd.Flags().GetString("password")
    algorithm, _ := cmd.Flags().GetString("algorithm")
    useSSL, _ := cmd.Flags().GetBool("ssl")
    threads, _ := cmd.Flags().GetInt("threads")

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

    cfg.Pool.URL = ensureStratumURL(url, useSSL)
    cfg.Pool.WalletAddress = wallet
    cfg.Pool.WorkerName = worker
    cfg.Pool.Password = password
    // Ensure we don't start local pool manager for external pool mining
    cfg.Pool.Enabled = false

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
    logger.Info("Connecting to pool",
        zap.String("url", cfg.Pool.URL),
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

    fmt.Println("Mining started. Press Ctrl+C to stop.")

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

// ensureStratumURL normalizes the pool URL to include the appropriate scheme based on SSL flag.
func ensureStratumURL(u string, ssl bool) string {
    s := strings.TrimSpace(u)
    if s == "" {
        return s
    }
    hasScheme := strings.Contains(s, "://")
    if ssl {
        if strings.HasPrefix(s, "stratum+ssl://") {
            return s
        }
        if strings.HasPrefix(s, "stratum+tcp://") {
            return "stratum+ssl://" + s[len("stratum+tcp://"):]
        }
        if strings.HasPrefix(s, "stratum://") {
            return "stratum+ssl://" + s[len("stratum://"):]
        }
        if hasScheme {
            return s
        }
        return "stratum+ssl://" + s
    }
    // Non-SSL
    if strings.HasPrefix(s, "stratum+tcp://") || strings.HasPrefix(s, "stratum://") {
        return s
    }
    if strings.HasPrefix(s, "stratum+ssl://") {
        return "stratum+tcp://" + s[len("stratum+ssl://"):]
    }
    if hasScheme {
        return s
    }
    return "stratum+tcp://" + s
}