package commands

import (
	"context"
	"fmt"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shizukutanaka/Otedama/internal/app"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// startCmd represents the start command
var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start Otedama mining",
	Long: `Start Otedama mining with the specified configuration.
	
Examples:
  # Start with default config
  otedama start
  
  # Start with specific config
  otedama start --config custom-config.yaml
  
  # Start in daemon mode
  otedama start --daemon --log-file otedama.log
  
  # Start with performance profiling
  otedama start --profile --profile-port 6060`,
	RunE: runStart,
}

func init() {
	rootCmd.AddCommand(startCmd)
	
	startCmd.Flags().String("config", "config.yaml", "Configuration file path")
	startCmd.Flags().Bool("daemon", false, "Run as daemon")
	startCmd.Flags().String("log-file", "", "Log file path (for daemon mode)")
	startCmd.Flags().Bool("profile", false, "Enable performance profiling")
	startCmd.Flags().Int("profile-port", 6060, "Performance profiling port")
	startCmd.Flags().String("pid-file", "otedama.pid", "PID file path")
}

func runStart(cmd *cobra.Command, args []string) error {
	configPath, _ := cmd.Flags().GetString("config")
	isDaemon, _ := cmd.Flags().GetBool("daemon")
	logFile, _ := cmd.Flags().GetString("log-file")
	enableProfile, _ := cmd.Flags().GetBool("profile")
	profilePort, _ := cmd.Flags().GetInt("profile-port")
	pidFile, _ := cmd.Flags().GetString("pid-file")
	
	// Load configuration
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("failed to load configuration: %w", err)
	}
	
	// Initialize logger
	logger, err := initializeLogger(cfg, isDaemon, logFile)
	if err != nil {
		return fmt.Errorf("failed to initialize logger: %w", err)
	}
	defer logger.Sync()
	
	// Daemonize if requested
	if isDaemon {
		if err := daemonize(); err != nil {
			return fmt.Errorf("failed to daemonize: %w", err)
		}
	}
	
	// Write PID file
	if err := writePIDFile(pidFile); err != nil {
		logger.Warn("Failed to write PID file", zap.Error(err))
	}
	defer os.Remove(pidFile)
	
	// Enable profiling if requested
	if enableProfile {
		go startProfiling(profilePort, logger)
	}
	
	// Create application context
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	
	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	// Create and start application
	logger.Info("Starting Otedama",
		zap.String("version", Version),
		zap.String("config", configPath),
		zap.Bool("daemon", isDaemon),
	)
	
	application, err := app.New(ctx, logger, cfg)
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}
	
	if err := application.Start(); err != nil {
		return fmt.Errorf("failed to start application: %w", err)
	}
	
	logger.Info("Otedama started successfully")
	
	// Print startup information
	if !isDaemon {
		printStartupInfo(cfg)
	}
	
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
	
	logger.Info("Otedama stopped successfully")
	return nil
}

func initializeLogger(cfg *config.Config, isDaemon bool, logFile string) (*zap.Logger, error) {
	var zapCfg zap.Config
	
	if isDaemon || logFile != "" {
		// Production logger for daemon mode
		zapCfg = zap.NewProductionConfig()
		
		if logFile != "" {
			zapCfg.OutputPaths = []string{logFile}
			zapCfg.ErrorOutputPaths = []string{logFile}
		}
	} else {
		// Development logger for interactive mode
		zapCfg = zap.NewDevelopmentConfig()
		zapCfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	}
	
	// Set log level from config
	switch cfg.Logging.Level {
	case "debug":
		zapCfg.Level = zap.NewAtomicLevelAt(zap.DebugLevel)
	case "info":
		zapCfg.Level = zap.NewAtomicLevelAt(zap.InfoLevel)
	case "warn":
		zapCfg.Level = zap.NewAtomicLevelAt(zap.WarnLevel)
	case "error":
		zapCfg.Level = zap.NewAtomicLevelAt(zap.ErrorLevel)
	}
	
	return zapCfg.Build()
}

func daemonize() error {
	// Fork the process
	// Note: This is a simplified version. Full daemonization would require
	// proper fork/exec handling which is complex in Go.
	// For production use, consider using a service manager like systemd.
	
	// Redirect stdin/stdout/stderr to /dev/null
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		return err
	}
	
	os.Stdin = devNull
	os.Stdout = devNull
	os.Stderr = devNull
	
	// Change working directory to root
	if err := os.Chdir("/"); err != nil {
		return err
	}
	
	// Clear umask
	syscall.Umask(0)
	
	return nil
}

func writePIDFile(path string) error {
	pid := os.Getpid()
	data := []byte(fmt.Sprintf("%d\n", pid))
	return os.WriteFile(path, data, 0644)
}

func startProfiling(port int, logger *zap.Logger) {
	logger.Info("Starting performance profiling server", zap.Int("port", port))
	
	// Register pprof handlers
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	
	server := &http.Server{
		Addr:    fmt.Sprintf("localhost:%d", port),
		Handler: mux,
	}
	
	if err := server.ListenAndServe(); err != nil {
		logger.Error("Profiling server error", zap.Error(err))
	}
}

func printStartupInfo(cfg *config.Config) {
	fmt.Println("\n=== Otedama Mining Software ===")
	fmt.Printf("Version: %s\n", Version)
	fmt.Printf("Mode: %s\n", cfg.Mode)
	fmt.Printf("P2P: %v (Port: %s)\n", cfg.P2P.Enabled, cfg.Network.ListenAddr)
	fmt.Printf("ZKP Auth: %v\n", cfg.ZKP.Enabled)
	fmt.Printf("Dashboard: http://localhost:%d\n", cfg.Monitoring.DashboardPort)
	fmt.Printf("API: http://localhost:%d\n", cfg.Monitoring.APIPort)
	fmt.Println("\nPress Ctrl+C to stop mining")
	fmt.Println("===============================\n")
}